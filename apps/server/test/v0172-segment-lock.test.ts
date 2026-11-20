import { randomUUID } from 'node:crypto';
import { refreshPeople } from '@agentic-marketing/segments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #1104: two writers of one segment's memberships used to deadlock. The full refresh inserts the
// people it found and the streaming update inserts the people an event batch touched; with the same
// people in both, each waited on a row the other held. They now take one transaction-scoped lock per
// segment before they write. This file holds that lock from a test connection and proves both
// writers queue on it — not that they merely finish quickly — then releases it and checks both
// commit.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';

const api = () => t.api(owner, ws);

beforeAll(async () => {
  t = await startTestServer('test_v0172_segment_lock', testPort(4472));
  owner = await t.signUp(`segment-lock-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 90_000);

afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

async function person(userId: string) {
  await send([{ type: 'identify', userId }]);
  return (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;
}

const lockKey = (segmentId: string) => `segment:${segmentId}`;

/** The SQL predicate for this segment's advisory lock in `pg_locks`, as the lock-protocol tests use. */
const waitersSql = `
  SELECT pid FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND NOT l.granted
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
     AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid`;

/** How many backends are queued on this segment's membership lock right now. */
async function segmentWaiters(segmentId: string): Promise<number[]> {
  const { rows } = await t.srv.db.admin.query<{ pid: number }>(waitersSql, [lockKey(segmentId)]);
  return rows.map((r) => r.pid);
}

/** Waits (bounded) until at least `count` backends are queued on the lock; never a fixed sleep. */
async function waitForSegmentWaiters(segmentId: string, count: number): Promise<number[]> {
  const started = Date.now();
  for (;;) {
    const pids = await segmentWaiters(segmentId);
    if (pids.length >= count) return pids;
    if (Date.now() - started > 15_000)
      throw new Error(`timed out waiting for ${count} writers to queue on ${lockKey(segmentId)}; saw ${pids.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('writers of one segment serialise (#1104)', () => {
  it('queues a full refresh and an incremental update behind the segment lock, and both commit', async () => {
    const ada = await person('v0172-hold-ada');
    const bo = await person('v0172-hold-bo');
    const { artifactId } = await api().call('artifacts.create', {
      type: 'segment',
      name: 'People on Holdvej',
      content: { mode: 'dynamic', condition: { trait: 'city', op: 'eq', value: 'Holdvej' } },
    });
    await api().call('artifacts.requestPublish', { artifactId, note: 'test' });

    // Both match the rule, but no membership row exists yet: the two writers below would both
    // insert these same people.
    await t.srv.db.admin.query(
      `UPDATE profiles SET traits = jsonb_build_object('city', 'Holdvej') WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [ws, [ada, bo]],
    );

    // Hold the segment's membership lock from a test connection: the only way either writer can
    // reach its membership rows is by queueing on this key.
    const probe = await t.srv.db.admin.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(artifactId)]);

      // The full refresh of the whole segment.
      const refresh = api().call('segments.refresh', { artifactId });
      // The streaming update: evaluate the rule for the person an event batch touched and apply the
      // difference (the same `applyDiff` the segment hook runs).
      const update = t.srv.db.withWorkspace(ws, (tx) => refreshPeople(tx, ws, [ada], t.srv.events, 'test:segment-lock'));

      // Both reached the lock and are waiting; neither wrote a membership row.
      const waiting = await waitForSegmentWaiters(artifactId, 2);
      expect(waiting).toHaveLength(2);
      const { rows: written } = await t.srv.db.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2',
        [ws, artifactId],
      );
      expect(written[0]?.n).toBe(0);

      await probe.query('COMMIT');

      const [refreshed] = await Promise.all([refresh, update]);
      // Which writer commits first decides who counts the other's insert as entered, so the
      // membership is the outcome to assert, not the entered/exited split.
      expect(refreshed.members).toBe(2);
      const members = await api().call('segments.members', { artifactId });
      expect(members.members.map((m) => m.profileId).sort()).toEqual([ada, bo].sort());
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
  }, 120_000);

  it('leaves a second writer waiting while the first one holds the lock (#1104)', async () => {
    // The same property from the other side: with the lock held, a list command cannot write the
    // membership row, so a merge cannot be racing it. The list itself is an ordinary static list.
    const cy = await person(`v0172-hold-${randomUUID().replaceAll('-', '').slice(0, 8)}`);
    const list = await api().call('artifacts.create', { type: 'segment', name: 'Held list', content: { mode: 'static' } });

    const probe = await t.srv.db.admin.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(list.artifactId)]);

      const add = api().call('audiences.add', { segmentId: list.artifactId, profileIds: [cy] });
      await waitForSegmentWaiters(list.artifactId, 1);
      const { rows } = await t.srv.db.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2',
        [ws, list.artifactId],
      );
      expect(rows[0]?.n).toBe(0);

      await probe.query('COMMIT');
      await expect(add).resolves.toMatchObject({ added: 1 });
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
  }, 60_000);
});
