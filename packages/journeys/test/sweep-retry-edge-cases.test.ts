import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1240 review: a database error during advance aborts the sweep's transaction, and the retry
// bookkeeping then failed with 25P02, so the participant stayed due and the sweep exited every
// round. The retry must run after a savepoint rollback, and a failing workspace must not stop the
// others. A goal that timed out must not convert because an event arrived during the backoff.

const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

/** An event store whose ClickHouse is unreachable while `down` is true. When it is up, `userId`
 * counts one matching event for that person, so a wait-until can be satisfied. */
const store = (down: () => boolean, userId = '') =>
  ({
    async insertJourneyEvents() {},
    async countEvents() {
      if (down()) throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
      return userId ? [{ anonymousId: '', userId, count: 1 }] : [];
    },
  }) as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_retry_edge_cases');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 180_000);

beforeEach(async () => {
  if (!hasTestDatabase()) return;
  await d.db.admin.query('DELETE FROM journey_participants WHERE workspace_id = $1', [ws]);
});

afterAll(async () => {
  await d?.close();
});

async function publishedJourney(name: string, nodes: unknown[]): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, name],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [ws, journeyId, JSON.stringify({ purpose: 'marketing_email', nodes }), `hash_${journeyId}`],
  );
  return journeyId;
}

async function participant(journeyId: string, row: Record<string, unknown>) {
  const profileId = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId });
    await tx.insert(schema.journeyParticipants).values({
      workspaceId: ws,
      journeyId,
      version: 1,
      profileId,
      entryKey: `transient:${profileId}`,
      context: {},
      ...row,
    } as never);
  });
  return profileId;
}

const statusOf = async (profileId: string) =>
  (
    await d.db.admin.query<{ status: string; due_at: Date | null; error: string | null; attempts: number }>(
      'SELECT status, due_at, error, attempts FROM journey_participants WHERE workspace_id = $1 AND profile_id = $2',
      [ws, profileId],
    )
  ).rows[0];

async function eventBranch(dueAt: Date) {
  const journey = await publishedJourney('Review branch on an event', [
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'ask' }] },
    {
      id: 'ask',
      kind: 'branch',
      label: 'Activated?',
      config: { condition: { event: 'Activated' } },
      next: [{ to: 'done' }, { to: 'done' }],
    },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);
  return participant(journey, { node: 'start', status: 'ready', dueAt });
}

describe.skipIf(!hasTestDatabase())('journey retry review', () => {
  it('schedules a full backoff after a slow event-store failure', async () => {
    let now = Date.now();
    const profileId = await eventBranch(new Date(now - 1000));
    const events = store(() => {
      now += 30_000;
      return true;
    });
    await sweep(d.db, { kp, events }, { now: () => new Date(now) });

    expect((await statusOf(profileId))?.due_at?.getTime()).toBe(now + 15_000);
  });

  it('can reschedule a participant after a PostgreSQL statement fails during advance', async () => {
    const { sql } = await import('drizzle-orm');
    const profileId = await eventBranch(new Date(Date.now() - 1000));
    type Tx = Parameters<Parameters<typeof d.db.withWorkspace>[1]>[0];
    let activeTx: Tx;
    const db = {
      ...d.db,
      withWorkspace: <T>(workspaceId: string, callback: (tx: Tx) => Promise<T>) =>
        d.db.withWorkspace(workspaceId, async (tx) => {
          activeTx = tx;
          return callback(tx);
        }),
    };
    const events = {
      async countEvents() {
        await activeTx.execute(sql`SELECT 1 / 0`);
        return [];
      },
    } as unknown as EventStore;
    await expect(sweep(db, { kp, events })).resolves.toBe(1);
    expect((await statusOf(profileId))?.due_at?.getTime()).toBeGreaterThan(Date.now());
  });

  it('continues with the next workspace when one workspace fails as a whole', async () => {
    // Two workspaces are due; the first one's transaction throws outside the participant handler
    // (a dead connection, a failed claim), and the round must still reach the second.
    const visited: string[] = [];
    const db = {
      admin: { query: async () => ({ rows: [{ workspace_id: 'ws_failing' }, { workspace_id: 'ws_healthy' }] }) },
      withWorkspace: async (workspaceId: string) => {
        visited.push(workspaceId);
        if (workspaceId === 'ws_failing') throw new Error('the workspace transaction failed');
        return 0;
      },
    } as unknown as Parameters<typeof sweep>[0];
    await expect(sweep(db, { kp, events: store(() => false) })).resolves.toBe(0);
    expect(visited).toEqual(['ws_failing', 'ws_healthy']);
  });

  it('fails on the third failure, and a successful advance restores a full budget', async () => {
    const journey = await publishedJourney('Transient branch, wait, transient branch', [
      { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'first' }] },
      {
        id: 'first',
        kind: 'branch',
        label: 'Activated?',
        config: { condition: { event: 'Activated' } },
        next: [{ to: 'wait' }, { to: 'wait' }],
      },
      { id: 'wait', kind: 'wait', label: 'Wait', config: { duration: 'PT1H' }, next: [{ to: 'second' }] },
      {
        id: 'second',
        kind: 'branch',
        label: 'Purchased?',
        config: { condition: { event: 'Purchased' } },
        next: [{ to: 'done' }, { to: 'done' }],
      },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ]);
    const profileId = await participant(journey, { node: 'start', status: 'ready', dueAt: new Date(Date.now() - 60_000) });
    const base = Date.now();
    const at = (ms: number) => new Date(base + ms);

    // First failure at the first branch: attempt 1, still due for a retry.
    await sweep(d.db, { kp, events: store(() => true) }, { now: () => at(0) });
    expect(await statusOf(profileId)).toMatchObject({ status: 'ready', attempts: 1 });

    // The next advance succeeds into a wait: the budget is fresh again.
    await sweep(d.db, { kp, events: store(() => false) }, { now: () => at(3_600_000) });
    expect(await statusOf(profileId)).toMatchObject({ status: 'waiting', attempts: 0, error: null });

    // The wait expires and the second branch fails: a fresh budget starts at one, not two.
    await sweep(d.db, { kp, events: store(() => true) }, { now: () => at(7_200_000) });
    expect(await statusOf(profileId)).toMatchObject({ status: 'waiting', attempts: 1 });
    await sweep(d.db, { kp, events: store(() => true) }, { now: () => at(7_215_000) });
    expect(await statusOf(profileId)).toMatchObject({ status: 'waiting', attempts: 2 });

    // Exactly three consecutive failures spend the budget; the third fails the participant.
    await sweep(d.db, { kp, events: store(() => true) }, { now: () => at(7_245_000) });
    expect(await statusOf(profileId)).toMatchObject({ status: 'failed', attempts: 3, due_at: null });
  });
});

describe.skipIf(!hasTestDatabase())('journey wait retry review', () => {
  it('preserves an expired goal while its downstream branch is retried', async () => {
    const { wakeWaiters } = await import('../src/runtime');
    const journey = await publishedJourney('Goal followed by a timeout branch', [
      { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'goal' }] },
      {
        id: 'goal',
        kind: 'goal',
        label: 'Order within an hour',
        config: { event: 'Order', within: 'PT1H' },
        next: [{ to: 'converted' }, { to: 'branch' }],
      },
      {
        id: 'branch',
        kind: 'branch',
        label: 'Activated?',
        config: { condition: { event: 'Activated' } },
        next: [{ to: 'timed_out' }, { to: 'timed_out' }],
      },
      { id: 'converted', kind: 'exit', label: 'Converted', config: {} },
      { id: 'timed_out', kind: 'exit', label: 'Timed out', config: {} },
    ]);
    const profileId = await participant(journey, {
      node: 'goal',
      status: 'waiting',
      dueAt: new Date(Date.now() - 30_000),
      waitingEvent: 'Order',
      seq: 2,
    });
    expect(await sweep(d.db, { kp, events: store(() => true) })).toBe(1);
    expect(await statusOf(profileId)).toMatchObject({ status: 'waiting', error: expect.stringContaining('ECONNREFUSED') });

    const receivedAt = new Date().toISOString();
    await d.db.withWorkspace(ws, (tx) =>
      wakeWaiters(tx, ws, [
        {
          profileId,
          event: {
            workspaceId: ws,
            sourceId: 'src_review',
            messageId: newId('evt'),
            name: 'Order',
            type: 'track',
            receivedAt,
            timestamp: receivedAt,
            anonymousId: '',
            userId: '',
            properties: {},
            traits: {},
            piiTraits: {},
            context: {},
            consent: {},
          },
        },
      ]),
    );
    await sweep(d.db, { kp, events: store(() => false) }, { now: () => new Date(Date.now() + 60_000) });
    const { rows } = await d.db.admin.query(
      'SELECT node, converted FROM journey_participants WHERE workspace_id = $1 AND profile_id = $2',
      [ws, profileId],
    );
    expect(rows).toEqual([{ node: 'timed_out', converted: false }]);
  });
});
