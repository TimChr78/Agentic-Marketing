import { sweepArchivedApprovals } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #957: reject-on-archived ran only inside approvals.approve and the held runner, so an upgrade
// that archived a duplicate left its pending request in the queue forever, inflating the badge and
// showing a raw `policy:archived` sentinel as the decider. The startup sweep closes them, the list
// marks an archived artifact, the badge ignores it, and approvals.get renders the sentinel as a
// system actor.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;

beforeAll(async () => {
  t = await startTestServer('test_v01426_957', testPort(4491));
  owner = await t.signUp(`owner-v01426-957-${Date.now()}@example.com`);
  approver = await t.signUp(`approver-v01426-957-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const note = (title: string) => ({ title, body: 'Written for the archived-approval sweep test.' });

const archive = (ws: string, id: string) =>
  t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, id]);

const approvalRows = async (ws: string, ids: string[]) =>
  (
    await t.srv.db.admin.query<{
      id: string;
      status: string;
      decided_by: string | null;
      decision_note: string | null;
      hold_until: Date | null;
    }>(
      'SELECT id, status, decided_by, decision_note, hold_until FROM approval_requests WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY id',
      [ws, ids],
    )
  ).rows;

const versionState = async (ws: string, artifactId: string, number: number) =>
  (
    await t.srv.db.admin.query<{ state: string }>(
      'SELECT state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = $3',
      [ws, artifactId, number],
    )
  ).rows[0]?.state;

/** A workspace where every publish waits for a person, with a pending note request. */
async function pendingNote(name: string) {
  const ws = await t.workspaceWith(
    [
      [owner, 'owner'],
      [approver, 'approver'],
    ],
    'all_publishes',
  );
  const api = t.api(owner, ws);
  const created = await api.call('artifacts.create', { type: 'note', name, content: note(name) });
  const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
  expect(request.status).toBe('in_review');
  return { ws, api, artifactId: created.artifactId, approvalId: request.approvalId as string, version: request.version as number };
}

describe('pending approvals on archived artifacts are swept (#957)', () => {
  it('closes them as rejected with the reason, marks the version rejected and is idempotent', async () => {
    const s = await pendingNote('Archived by the upgrade');

    const before = await t.api(owner, s.ws).call('approvals.list', { status: 'pending' });
    expect(before.total).toBe(1);

    await archive(s.ws, s.artifactId);

    // The redacted reason is the one closeRejected writes: the artifact id and name, nothing else.
    const swept = await sweepArchivedApprovals(t.srv.db);
    expect(swept.closed).toBeGreaterThan(0);

    const [row] = await approvalRows(s.ws, [s.approvalId]);
    expect(row).toMatchObject({ status: 'rejected', decided_by: 'policy:archived' });
    expect(row?.decision_note).toContain(s.artifactId);
    expect(row?.decision_note).toMatch(/archived/);
    expect(row?.hold_until).toBeNull();
    expect(await versionState(s.ws, s.artifactId, s.version)).toBe('rejected');

    const after = await t.api(owner, s.ws).call('approvals.list', { status: 'pending' });
    expect(after.total).toBe(0);
    expect(after.approvals).toEqual([]);

    // Cheap and idempotent: a second pass finds nothing to close.
    expect((await sweepArchivedApprovals(t.srv.db)).closed).toBe(0);
  });

  it('marks an archived artifact on the pending row and excludes it from the badge', async () => {
    const s = await pendingNote('Archived but not yet swept');
    await archive(s.ws, s.artifactId);

    // Before the sweep: the row is still pending, so the list says why it can never publish...
    const listed = await t.api(owner, s.ws).call('approvals.list', { status: 'pending' });
    expect(listed.total).toBe(1);
    expect(listed.approvals[0]).toMatchObject({ id: s.approvalId, archived: true });

    // ...and the shell badge does not count it.
    expect((await t.api(owner, s.ws).call('system.status', {})).pendingApprovals).toBe(0);

    // A live artifact's request still counts and is not marked archived.
    const live = await pendingNote('Still live');
    expect((await t.api(owner, live.ws).call('system.status', {})).pendingApprovals).toBe(1);
    expect((await t.api(owner, live.ws).call('approvals.list', { status: 'pending' })).approvals[0]?.archived).toBe(false);
  });

  it('renders the policy sentinel as a system actor in the decision history', async () => {
    const s = await pendingNote('Whose decision');
    await archive(s.ws, s.artifactId);
    await sweepArchivedApprovals(t.srv.db);

    const detail = await t.api(approver, s.ws).call('approvals.get', { approvalId: s.approvalId });
    expect(detail.status).toBe('rejected');
    expect(detail.decidedBy).toBe('policy:archived');
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({ status: 'rejected', by: { id: 'policy:archived', name: 'System (policy)' } });
    expect(detail.history[0]?.note).toContain(s.artifactId);
  });

  it('closes a whole bundle when one member is archived, so the other is not left undecidable', async () => {
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Bundle first', content: note('First') });
    const second = await api.call('artifacts.create', { type: 'note', name: 'Bundle second', content: note('Second') });
    const bundle = await api.call('artifacts.requestPublishBundle', {
      artifactIds: [first.artifactId, second.artifactId],
      note: 'Both together',
    });
    expect(bundle.members).toHaveLength(2);

    await archive(ws, second.artifactId);
    await sweepArchivedApprovals(t.srv.db);

    const ids = bundle.members.map((m) => m.approvalId as string);
    const rows = await approvalRows(ws, ids);
    expect(rows.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(rows.every((r) => r.decided_by === 'policy:archived')).toBe(true);
    expect(rows.every((r) => r.decision_note?.includes(second.artifactId))).toBe(true);
    for (const m of bundle.members) expect(await versionState(ws, m.artifactId, m.version)).toBe('rejected');
    // Nothing is left for the queue, so nobody discovers the archived member by approving.
    const queue = await api.call('approvals.list', { status: 'pending' });
    expect(queue.total).toBe(0);
  });

  it('redacts a credential in the archived artifact’s name before writing the reason', async () => {
    // The reason quotes the artifact's name, and an artifact name is caller-supplied text: a
    // credential pasted into it must not reach the decision note (#950 review).
    const s = await pendingNote('Pending note password=review_dummy_secret');
    await archive(s.ws, s.artifactId);
    await sweepArchivedApprovals(t.srv.db);

    const [row] = await approvalRows(s.ws, [s.approvalId]);
    expect(row?.status).toBe('rejected');
    expect(row?.decision_note).not.toContain('review_dummy_secret');
    expect(row?.decision_note).toContain('[redacted]');
    expect(row?.decision_note).toContain(s.artifactId);
  });

  it('leaves requests whose artifacts are live alone', async () => {
    const s = await pendingNote('Nothing archived here');
    await sweepArchivedApprovals(t.srv.db);
    const [row] = await approvalRows(s.ws, [s.approvalId]);
    expect(row?.status).toBe('pending');
    expect(row?.decided_by).toBeNull();
    expect(await versionState(s.ws, s.artifactId, s.version)).toBe('in_review');
  });
});
