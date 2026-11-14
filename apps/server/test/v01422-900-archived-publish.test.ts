import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHoldsOnce } from '../src/agents/holds';
import { startTestServer, testPort, type User } from './harness';

// #900: no publish path may put a version live on an archived artifact. Migration 0092 and
// config.import archive duplicate rows instead of deleting them, and a pending approval request or
// held change that names one survives the upgrade; approving it would recreate two live configs.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_900', testPort(4461));
  owner = await t.signUp(`owner-v01422-900-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const note = (title: string) => ({ title, body: 'Written for the artifact integrity test.' });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const stopped = (what: 'pause' | 'revoke') => (what === 'pause' ? 'paused' : 'revoked');

const archive = (ws: string, id: string) =>
  t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, id]);

const artifactRow = async (ws: string, id: string) =>
  (
    await t.srv.db.admin.query<{ archived: boolean; published_version: number | null }>(
      'SELECT archived, published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0];

const approvalRow = async (ws: string, id: string) =>
  (
    await t.srv.db.admin.query<{ status: string; decision_note: string | null; hold_until: Date | null }>(
      'SELECT status, decision_note, hold_until FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0];

const versionRow = async (ws: string, artifactId: string, number: number) =>
  (
    await t.srv.db.admin.query<{ state: string }>(
      'SELECT state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = $3',
      [ws, artifactId, number],
    )
  ).rows[0];

/** An agent whose mandate holds content publishes for a veto window. */
async function agentSetup() {
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', { name: 'Archived holder', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
  ).token as string;
  const agentCall = async (name: string, body: unknown = {}) => {
    const res = await fetch(`${t.base}/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const agentId = (await agentCall('agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Hold content publishes',
    content: { agent: agentId, purpose: 'Test archived publishes', validUntil: inDays(30), levels: { 'content.publish': 2 } } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { ws, api, token, agentId, agentCall };
}

describe('no publish path accepts an archived artifact (#900)', () => {
  it('requestPublish refuses an archived artifact and creates no request', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Archived note', content: note('Body') });
    await archive(ws, created.artifactId);

    const err = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Publish me' }).catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(created.artifactId);
    expect(err.message).toMatch(/archived/);

    const requests = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM approval_requests WHERE workspace_id = $1 AND artifact_id = $2',
      [ws, created.artifactId],
    );
    expect(requests.rows[0]?.n).toBe(0);
    expect(await artifactRow(ws, created.artifactId)).toMatchObject({ archived: true, published_version: null });
  });

  it('names both ids for an archived singleton that has an active successor', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const archived = await api.call('artifacts.create', { type: 'brand', name: 'Old brand', content: { siteName: 'Old' } });
    await archive(ws, archived.artifactId);
    const active = await api.call('artifacts.create', { type: 'brand', name: 'Active brand', content: { siteName: 'Active' } });

    const err = await api.call('artifacts.requestPublish', { artifactId: archived.artifactId, note: 'Restore it' }).catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(archived.artifactId);
    expect(err.message).toContain(active.artifactId);
    expect(await artifactRow(ws, archived.artifactId)).toMatchObject({ archived: true, published_version: null });
  });

  it('requestPublishBundle refuses a bundle with an archived member and creates no request', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Bundle one', content: note('One') });
    const second = await api.call('artifacts.create', { type: 'note', name: 'Bundle two', content: note('Two') });
    await archive(ws, second.artifactId);

    const err = await api
      .call('artifacts.requestPublishBundle', { artifactIds: [first.artifactId, second.artifactId], note: 'Both' })
      .catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(second.artifactId);
    const requests = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM approval_requests WHERE workspace_id = $1 AND artifact_id = ANY($2::text[])',
      [ws, [first.artifactId, second.artifactId]],
    );
    expect(requests.rows[0]?.n).toBe(0);
  });

  it('approving a request that names an archived artifact rejects it with the reason and publishes nothing', async () => {
    const approver = await t.signUp(`approver-v01422-900-${Date.now()}@example.com`);
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const approverApi = t.api(approver, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Pending note', content: note('Body') });
    const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
    expect(request.status).toBe('in_review');

    // The artifact is archived after the request was made (migration 0092, or a config.import restore).
    await archive(ws, created.artifactId);

    const out = await approverApi.call('approvals.approve', { approvalId: request.approvalId as string });
    expect(out.status).toBe('rejected');
    expect(out.published).toEqual([]);
    expect(out.reason).toContain(created.artifactId);
    expect(await artifactRow(ws, created.artifactId)).toMatchObject({ archived: true, published_version: null });
    const row = await approvalRow(ws, request.approvalId as string);
    expect(row?.status).toBe('rejected');
    expect(row?.decision_note).toMatch(/archived/);
    expect(await versionRow(ws, created.artifactId, request.version)).toMatchObject({ state: 'rejected' });
  });

  // #922 A3: the archived check comes before the stopped-agent rule, so a request that can never
  // publish is closed even when its requester was paused or revoked afterwards.
  for (const stop of ['pause', 'revoke'] as const) {
    it(`closes an archived request from a ${stopped(stop)} agent as rejected instead of leaving it pending`, async () => {
      const s = await agentSetup();
      const created = await s.agentCall('artifacts.create', {
        type: 'note',
        name: `Archived for a ${stop}`,
        content: { title: 'Held', body: 'A request that names an artifact archived afterwards.' },
      });
      expect(created.status).toBe(200);
      const held = await s.agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'Held publish' });
      expect(held.body.status).toBe('on_hold');
      await archive(s.ws, created.body.artifactId as string);
      await s.api.call(stop === 'pause' ? 'agents.pause' : 'agents.revoke', { id: s.agentId, reason: `Stopped before review` });

      const out = await s.api.call('approvals.approve', { approvalId: held.body.approvalId as string });
      expect(out.status).toBe('rejected');
      expect(out.reason).toMatch(/archived/);
      expect(await artifactRow(s.ws, created.body.artifactId as string)).toMatchObject({ archived: true, published_version: null });
      const row = await approvalRow(s.ws, held.body.approvalId as string);
      expect(row?.status).toBe('rejected');
      expect(row?.decision_note).toMatch(/archived/);
      expect(await versionRow(s.ws, created.body.artifactId as string, held.body.version as number)).toMatchObject({ state: 'rejected' });
    });
  }

  it('still refuses a paused agent’s request when its artifact is not archived', async () => {
    const s = await agentSetup();
    const created = await s.agentCall('artifacts.create', {
      type: 'note',
      name: 'Paused but publishable',
      content: { title: 'Held', body: 'A publishable request from an agent paused afterwards.' },
    });
    const held = await s.agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'Held publish' });
    expect(held.body.status).toBe('on_hold');
    await s.api.call('agents.pause', { id: s.agentId, reason: 'Stopped before review' });

    const err = await s.api.call('approvals.approve', { approvalId: held.body.approvalId as string }).catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/paused/i);
    const row = await approvalRow(s.ws, held.body.approvalId as string);
    expect(row?.status).toBe('pending');
  });

  it('a held change whose artifact was archived does not run; the request ends rejected with the reason', async () => {
    const s = await agentSetup();
    const created = await s.agentCall('artifacts.create', {
      type: 'note',
      name: 'Held archived note',
      content: { title: 'Held', body: 'A note held for a veto window.' },
    });
    expect(created.status).toBe(200);
    const held = await s.agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'Held publish' });
    expect(held.body.status).toBe('on_hold');
    const approvalId = held.body.approvalId as string;

    await archive(s.ws, created.body.artifactId as string);
    await t.srv.db.withWorkspace(s.ws, (tx) =>
      tx.execute(sql`UPDATE approval_requests SET hold_until = now() - interval '1 minute'
        WHERE workspace_id = ${s.ws} AND id = ${approvalId}`),
    );
    await runHoldsOnce({ db: t.srv.db, services: t.srv.services });

    expect(await artifactRow(s.ws, created.body.artifactId as string)).toMatchObject({ archived: true, published_version: null });
    const row = await approvalRow(s.ws, approvalId);
    expect(row?.status).toBe('rejected');
    expect(row?.hold_until).toBeNull();
    expect(row?.decision_note).toMatch(/archived/);
    expect(await versionRow(s.ws, created.body.artifactId as string, held.body.version as number)).toMatchObject({ state: 'rejected' });
  });

  it('artifacts.list hides archived rows by default, shows them on request and marks them', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const active = await api.call('artifacts.create', { type: 'note', name: 'Active note', content: note('Active') });
    const archived = await api.call('artifacts.create', { type: 'note', name: 'Archived note', content: note('Archived') });
    await archive(ws, archived.artifactId);

    const byDefault = await api.call('artifacts.list', { type: 'note' });
    expect(byDefault.artifacts.map((a) => a.id)).toEqual([active.artifactId]);
    expect(byDefault.total).toBe(1);
    expect(byDefault.artifacts[0]?.archived).toBe(false);

    const all = await api.call('artifacts.list', { type: 'note', includeArchived: true });
    expect(all.artifacts.map((a) => a.id).sort()).toEqual([active.artifactId, archived.artifactId].sort());
    expect(all.total).toBe(2);
    expect(all.artifacts.find((a) => a.id === archived.artifactId)?.archived).toBe(true);
  });
});
