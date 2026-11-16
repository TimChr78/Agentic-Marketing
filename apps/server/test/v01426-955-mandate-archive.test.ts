import { repairActiveMandates } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #955: a duplicate-mandate group with no usable mandate was recorded as repaired and never looked
// at again, and the validator told people to archive a mandate although no command could. A group
// left for a person is now re-examined by every pass, and `artifacts.archive` is the command the
// validator names.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01426_955', testPort(4492), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01426-955-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** A published mandate artifact, as a pre-fix install left duplicates behind. */
async function seedMandate(ws: string, content: unknown, opts: { name: string; updatedMinutesAgo: number }) {
  const id = newId('mnd');
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, created_at, updated_at)
     VALUES ($1, $2, 'agent_mandate', $3, 1, 1, now() - interval '30 days', now() - make_interval(mins => $4))`,
    [ws, id, opts.name, opts.updatedMinutesAgo],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', $5)`,
    [ws, id, content, `hash-${id}`, owner.id],
  );
  return id;
}

const valid = (agent: string) => ({ agent, purpose: 'Act for this workspace', validUntil: inDays(30) });
const invalid = (agent: string) => ({ agent, purpose: '', validUntil: inDays(30) });

const archivedOf = async (ws: string, ids: string[]) =>
  (
    await t.srv.db.admin.query<{ id: string; archived: boolean; name: string }>(
      'SELECT id, archived, name FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY id',
      [ws, ids],
    )
  ).rows;

const repairCount = async (ws: string) =>
  (
    await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM data_repairs WHERE name = 'single_active_mandate' AND workspace_id = $1",
      [ws],
    )
  ).rows[0]!.n;

describe('a mandate group with no usable mandate is re-examined (#955)', () => {
  it('records nothing and archives the duplicate once a row becomes usable', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const older = await seedMandate(ws, invalid(agent), { name: 'Broken one', updatedMinutesAgo: 60 });
    const newer = await seedMandate(ws, invalid(agent), { name: 'Broken two', updatedMinutesAgo: 30 });
    const logs: string[] = [];

    const first = await repairActiveMandates(t.srv.db, { log: (msg) => logs.push(msg) });
    expect(first.archived).toEqual([]);
    // Nothing is archived (the runtime uses neither row and guessing could archive the only one a
    // person will fix), and the workspace is left for the next pass instead of being recorded forever.
    expect(first.left).toContain(ws);
    expect(first.failed).toEqual([]);
    expect(first.recorded).toEqual([]);
    expect(await repairCount(ws)).toBe(0);
    expect(logs.join(' ')).toMatch(/none is usable/);

    // A later release loosens the schema (or a person fixes one row): the newer row is usable now.
    await t.srv.db.admin.query(
      'UPDATE artifact_versions SET content = $3, content_hash = $4 WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
      [ws, newer, valid(agent), `fixed-${newer}`],
    );

    const second = await repairActiveMandates(t.srv.db);
    expect(second.failed).toEqual([]);
    expect(second.left).toEqual([]);
    expect(second.archived).toContain(older);
    expect(second.recorded).toContain(ws);
    expect(await archivedOf(ws, [older, newer])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: older, archived: true }),
        expect.objectContaining({ id: newer, archived: false }),
      ]),
    );
    expect(await repairCount(ws)).toBe(1);
  });

  it('re-examines a workspace recorded by an older release instead of skipping it', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    await seedMandate(ws, invalid(agent), { name: 'Broken one', updatedMinutesAgo: 60 });
    await seedMandate(ws, invalid(agent), { name: 'Broken two', updatedMinutesAgo: 30 });
    // What 0.14.23 recorded for this group: a detail with no repair version.
    await t.srv.db.admin.query(`INSERT INTO data_repairs (name, workspace_id, detail) VALUES ('single_active_mandate', $1, '{}')`, [ws]);

    const out = await repairActiveMandates(t.srv.db);
    // It looked again (the record was written by the old rule, so it is dropped), found the same
    // unusable group and left it unrecorded: no false "done".
    expect(out.left).toContain(ws);
    expect(out.recorded).toEqual([]);
    expect(await repairCount(ws)).toBe(0);
  });
});

const agentCall = async (token: string, command: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** An agent whose id a mandate names. */
async function newAgent(api: ReturnType<typeof t.api>) {
  const token = (await api.call('apiTokens.create', { name: `Agent ${Date.now()}`, scopes: ['artifacts:read'] })).token as string;
  const me = await fetch(`${t.base}/v1/agents.get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  }).then(async (res) => (await res.json()) as { id: string });
  return me.id;
}

describe('artifacts.archive (#955)', () => {
  it('archives the active mandate so a new one can be published, and the validator names it', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agent = await newAgent(api);
    const first = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'First mandate',
      content: valid(agent) as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: first.artifactId, note: 'The first grant' })).status).toBe(
      'published',
    );
    const second = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Second mandate',
      content: valid(agent) as never,
    });

    const refused = await api.call('artifacts.requestPublish', { artifactId: second.artifactId, note: 'A renewal' }).catch((e) => e);
    expect(refused.code).toBe('invalid_input');
    expect(refused.message).toContain(first.artifactId);
    // The validator points at the command that exists, not at a manual archive nobody offers.
    expect(refused.message).toContain('artifacts.archive');

    const archived = await api.call('artifacts.archive', { artifactId: first.artifactId });
    expect(archived).toMatchObject({ artifactId: first.artifactId, archived: true, closedApprovals: 0 });
    expect(archived.name).toContain('archived');

    const again = await api.call('artifacts.archive', { artifactId: first.artifactId });
    expect(again.closedApprovals).toBe(0);
    expect(again.name).toBe(archived.name);

    // The renewal publishes now, and the retired mandate is hidden from the default list.
    expect((await api.call('artifacts.requestPublish', { artifactId: second.artifactId, note: 'The renewal' })).status).toBe('published');
    const byDefault = await api.call('artifacts.list', { type: 'agent_mandate' });
    expect(byDefault.artifacts.map((a) => a.id)).toEqual([second.artifactId]);
    const all = await api.call('artifacts.list', { type: 'agent_mandate', includeArchived: true });
    expect(all.artifacts.find((a) => a.id === first.artifactId)).toMatchObject({ archived: true });
  });

  it('closes the pending requests on the archived artifact with the policy decision', async () => {
    const approver = await t.signUp(`approver-v01426-955-${Date.now()}@example.com`);
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', {
      type: 'note',
      name: 'Ready for review',
      content: { title: 'Note', body: 'Body' },
    });
    const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
    expect(request.status).toBe('in_review');

    const archived = await api.call('artifacts.archive', { artifactId: created.artifactId });
    expect(archived.closedApprovals).toBe(1);

    const { rows } = await t.srv.db.admin.query<{ status: string; decided_by: string; decision_note: string }>(
      'SELECT status, decided_by, decision_note FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, request.approvalId as string],
    );
    expect(rows[0]).toMatchObject({ status: 'rejected', decided_by: 'policy:archived' });
    expect(rows[0]?.decision_note).toMatch(/archived/);
    const { rows: versions } = await t.srv.db.admin.query<{ state: string }>(
      'SELECT state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = $3',
      [ws, created.artifactId, request.version],
    );
    expect(versions[0]?.state).toBe('rejected');
  });

  it('refuses a workspace singleton and an agent', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const brand = await api.call('artifacts.create', { type: 'brand', name: 'Brand', content: { siteName: 'Brand' } });
    const refused = await api.call('artifacts.archive', { artifactId: brand.artifactId }).catch((e) => e);
    expect(refused.code).toBe('conflict');
    expect(refused.message).toMatch(/singleton|workspace needs/i);

    const token = (await api.call('apiTokens.create', { name: 'Archiver', scopes: ['artifacts:read', 'artifacts:write'] })).token as string;
    const note = await api.call('artifacts.create', { type: 'note', name: 'Agent target', content: { title: 'N', body: 'B' } });
    const agentAttempt = await agentCall(token, 'artifacts.archive', { artifactId: note.artifactId });
    expect(agentAttempt.status).toBe(403);
    expect(agentAttempt.body.message).toMatch(/person/i);
  });
});
