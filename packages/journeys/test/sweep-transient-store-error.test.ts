import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1240: one failed ClickHouse read during a sweep permanently failed the participant. A transient
// event-store error must leave the participant due with a backoff and retry it; only an exhausted
// retry budget may fail it. A broken condition still fails at once.

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
  d = await createDisposableDb('journey_transient_store');
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
    await d.db.admin.query<{ status: string; due_at: Date | null; error: string | null }>(
      'SELECT status, due_at, error FROM journey_participants WHERE workspace_id = $1 AND profile_id = $2',
      [ws, profileId],
    )
  ).rows[0];

describe.skipIf(!hasTestDatabase())('a transient event-store error in a sweep (#1240)', () => {
  it('leaves an event branch and a wait-until recheck due and completes them once the store is back', async () => {
    const branch = await publishedJourney('Branch on an event', [
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
    const until = await publishedJourney('Wait until an event', [
      { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'wait' }] },
      {
        id: 'wait',
        kind: 'waitUntil',
        label: 'Until activated',
        config: { condition: { event: 'Activated' }, timeout: 'P7D', recheck: 'PT1H' },
        next: [{ to: 'done' }],
      },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ]);
    const past = new Date(Date.now() - 60_000);
    const atBranch = await participant(branch, { node: 'start', status: 'ready', dueAt: past });
    const atWait = await participant(until, {
      node: 'wait',
      status: 'waiting',
      seq: 2,
      dueAt: past,
      waitingUntil: new Date(Date.now() + 86_400_000),
      matched: false,
    });
    // The healthy store reports one "Activated" event for this person, so the recheck can match.
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.identifiers).values({ workspaceId: ws, profileId: atWait, type: 'user_id', value: `user-${atWait}` }),
    );

    // The event store is unreachable for one sweep (a restart, a timeout under load).
    let down = true;
    expect(await sweep(d.db, { kp, events: store(() => down) })).toBe(2);
    // Neither is failed: both stay in the journey, due again after a backoff.
    expect(await statusOf(atBranch)).toMatchObject({ status: 'ready', due_at: expect.any(Date) });
    expect(await statusOf(atWait)).toMatchObject({ status: 'waiting', due_at: expect.any(Date) });
    expect((await statusOf(atBranch))?.error).toContain('ECONNREFUSED');
    // The backoff is in the future, so an immediate sweep does not hammer the store again.
    expect(await sweep(d.db, { kp, events: store(() => down) })).toBe(0);

    // ClickHouse is back: the retry advances both participants to the end of their journey.
    down = false;
    const later = new Date(Date.now() + 3_600_000);
    expect(await sweep(d.db, { kp, events: store(() => down, `user-${atWait}`) }, { now: () => later })).toBe(2);
    expect(await statusOf(atBranch)).toMatchObject({ status: 'completed' });
    expect(await statusOf(atWait)).toMatchObject({ status: 'completed' });
  }, 120_000);

  it('fails the participant only after the retry budget is exhausted', async () => {
    const journey = await publishedJourney('Always an event branch', [
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
    const profileId = await participant(journey, { node: 'start', status: 'ready', dueAt: new Date(Date.now() - 60_000) });
    const down = () => true;
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = new Date(Date.now() + attempt * 3_600_000);
      await sweep(d.db, { kp, events: store(down) }, { now: () => now });
      if ((await statusOf(profileId))?.status === 'failed') break;
    }
    const final = await statusOf(profileId);
    expect(final).toMatchObject({ status: 'failed', due_at: null });
    expect(final?.error).toContain('ECONNREFUSED');
  }, 120_000);

  it('still fails a broken condition at once', async () => {
    const journey = await publishedJourney('Broken condition', [
      { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'ask' }] },
      {
        id: 'ask',
        kind: 'branch',
        label: 'Broken?',
        config: { condition: { trait: 'plan', op: 'eq' } },
        next: [{ to: 'done' }, { to: 'done' }],
      },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ]);
    const profileId = await participant(journey, { node: 'start', status: 'ready', dueAt: new Date(Date.now() - 60_000) });
    expect(await sweep(d.db, { kp, events: store(() => false) })).toBe(1);
    expect(await statusOf(profileId)).toMatchObject({ status: 'failed', due_at: null });
    expect((await statusOf(profileId))?.error).toContain('needs a value');
  }, 120_000);
});
