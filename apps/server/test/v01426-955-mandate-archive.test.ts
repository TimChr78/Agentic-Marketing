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

/** The part of a raw connection these checks use. */
interface RawConn {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** Waits (bounded) until a backend is queued for this transaction id. */
async function waitForTransactionWaiter(conn: RawConn, xid: string, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const { rows } = await conn.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'transactionid' AND transactionid = $1::xid AND NOT granted`,
      [xid],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - started > timeoutMs) throw new Error('no backend waited for the archive transaction');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

  it('redacts a credential in the artifact name before writing the decision note', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', {
      type: 'note',
      name: 'Pending note password=review_dummy_secret',
      content: { title: 'N', body: 'B' },
    });
    const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
    expect(request.status).toBe('in_review');

    const archived = await api.call('artifacts.archive', { artifactId: created.artifactId });
    expect(archived.closedApprovals).toBe(1);
    const { rows } = await t.srv.db.admin.query<{ decision_note: string }>(
      'SELECT decision_note FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, request.approvalId as string],
    );
    expect(rows[0]?.decision_note).not.toContain('review_dummy_secret');
    expect(rows[0]?.decision_note).toContain('[redacted]');
  });

  it('a repeated archive closes only its own artifact’s requests', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Archived first', content: { title: 'A', body: 'A' } });
    const other = await api.call('artifacts.create', { type: 'note', name: 'Archived elsewhere', content: { title: 'B', body: 'B' } });
    const firstRequest = await api.call('artifacts.requestPublish', { artifactId: first.artifactId, note: 'First' });
    const otherRequest = await api.call('artifacts.requestPublish', { artifactId: other.artifactId, note: 'Other' });
    expect(firstRequest.status).toBe('in_review');
    expect(otherRequest.status).toBe('in_review');
    // Archived outside the command (migration 0092, the mandate repair, or config.import), with its
    // request still pending: the repeated call must not sweep this workspace on its behalf.
    await t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, other.artifactId]);

    const archived = await api.call('artifacts.archive', { artifactId: first.artifactId });
    expect(archived.closedApprovals).toBe(1);
    const again = await api.call('artifacts.archive', { artifactId: first.artifactId });
    expect(again).toMatchObject({ closedApprovals: 0, name: archived.name, archived: true });

    // The second call must not close another archived artifact's request and report it as ours.
    const { rows } = await t.srv.db.admin.query<{ status: string }>(
      'SELECT status FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, otherRequest.approvalId as string],
    );
    expect(rows[0]?.status).toBe('pending');
    const queue = await api.call('approvals.list', { status: 'pending' });
    expect(queue.approvals.map((a) => a.id)).toEqual([otherRequest.approvalId]);
  });

  it('closes a request that committed while the archive waited for the artifact lock', async () => {
    // A concurrent requestPublish can create its request after the archive's first read and before
    // its artifact lock. The archive re-reads under the lock and closes the new request, restarting
    // its plan so the approval-row lock still comes before the artifact lock.
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Racing note', content: { title: 'N', body: 'B' } });
    const approvalId = newId('apr');
    const holder = await t.srv.db.admin.connect();
    let archive: Promise<{ archived: boolean; closedApprovals: number }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, created.artifactId]);
      const xid = (await holder.query<{ xid: string }>('SELECT txid_current()::text AS xid')).rows[0]!.xid;
      archive = api.call('artifacts.archive', { artifactId: created.artifactId });
      await waitForTransactionWaiter(holder, xid);
      // The publisher commits its request while the archive waits for the artifact row.
      await t.srv.db.admin.query(
        `INSERT INTO approval_requests (workspace_id, id, artifact_id, version, status, requested_by_type, requested_by_id, note)
         VALUES ($1, $2, $3, 1, 'pending', 'user', $4, 'Raced request')`,
        [ws, approvalId, created.artifactId, owner.id],
      );
      await t.srv.db.admin.query(
        "UPDATE artifact_versions SET state = 'in_review' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1",
        [ws, created.artifactId],
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const out = await archive!;
    expect(out).toMatchObject({ archived: true, closedApprovals: 1 });
    const { rows } = await t.srv.db.admin.query<{ status: string; decided_by: string }>(
      'SELECT status, decided_by FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, approvalId],
    );
    expect(rows[0]).toMatchObject({ status: 'rejected', decided_by: 'policy:archived' });
  }, 60_000);

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
