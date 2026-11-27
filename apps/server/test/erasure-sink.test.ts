import type { Db } from '@agentic-marketing/db';
import {
  type BusEvent,
  CLICKHOUSE_SINK_CONSUMER,
  clickHouseStore,
  type EventBus,
  type EventStore,
  type JourneyEvent,
  natsConsumerState,
  runSink,
} from '@agentic-marketing/events';
import { erasedEventFilter, runErasureCleanupOnce, subjectKeyHasher } from '@agentic-marketing/profiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #978 mitigation (full contract in #1037): the sink drops a late erased-person event, direct
// writers skip a profile that no longer exists, and the cleanup's second sweep runs after a
// post-commit deadline. This narrows the resurrection window; it does not promise that a write
// already in flight at the ClickHouse server can never land later. There is deliberately no
// bus-progress barrier: a redelivery's ack says nothing about an earlier execution, and a moving
// stream tail would never let a job complete.

type Server = Awaited<ReturnType<typeof startTestServer>>;
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';

const send = (base: string, key: string, batch: unknown[]) =>
  fetch(`${base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

describe('erasure and the ClickHouse sink (#978)', () => {
  let t: Server;
  let owner: User;
  let ws = '';
  let key = '';
  let filter: ReturnType<typeof erasedEventFilter>;
  let sequence = 0;

  const busEvent = (anonymousId: string, messageId: string, at = new Date().toISOString()): BusEvent => ({
    workspaceId: ws,
    sourceId: 'src_test',
    messageId,
    type: 'track',
    name: 'Page Viewed',
    anonymousId,
    userId: '',
    timestamp: at,
    receivedAt: at,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  });

  /** A bus that runs one sink execution with the given batches and then ends. */
  const sinkBus = (batches: BusEvent[][]): EventBus => ({
    async consume(_opts, handler) {
      for (const batch of batches) await handler(batch);
    },
    async publish() {
      return { accepted: 0, duplicates: 0 };
    },
    async close() {},
  });

  const cleanupDeps = () => ({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, hot: t.srv.hot });

  const runJobNow = (erasureId: string) =>
    t.srv.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND erasure_id = $2', [
      ws,
      erasureId,
    ]);

  /** Drives the two-phase cleanup to completion: first sweep, then the distinct final sweep. */
  const completeErasure = async (erasureId: string) => {
    for (let round = 0; round < 3; round++) {
      const result = await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 0, outboxWaitSeconds: 0 });
      if (result.completed) return result;
      await runJobNow(erasureId);
    }
    throw new Error(`erasure ${erasureId} did not complete`);
  };

  const identify = async (api: ReturnType<Server['api']>, anonymousId: string, email: string) => {
    await send(t.base, key, [{ type: 'identify', anonymousId, traits: { email } }]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'anonymous_id', value: anonymousId }),
      (r) => !!r.profileId,
    );
    expect(profileId).toBeTruthy();
    return profileId!;
  };

  beforeAll(async () => {
    // The tests drive the cleanup rounds themselves, so the final-sweep bound is deterministic.
    t = await startTestServer('test_erasure_sink_final', testPort(3488), {}, { erasureCleanup: false });
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']]);
    key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
    filter = erasedEventFilter({ db: t.srv.db, kp: t.srv.keyProvider, graceHours: t.srv.erasureGraceHours });
  }, 60_000);
  afterAll(() => t?.close());

  it('removes a stalled sink insert released after the first sweep but before the final one', async () => {
    const api = t.api(owner);
    const profileId = await identify(api, 'dup-a', 'dup@example.com');
    const event = busEvent('dup-a', 'dup-c2');

    // Replica 1 passes the filter before the erasure and stalls inside its insert.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const insertStarted = new Promise<void>((resolve) => (started = resolve));
    let gated = false;
    const gatedStore: EventStore = {
      ...t.srv.events,
      async insert(events) {
        if (!gated) {
          gated = true;
          started();
          await held;
        }
        return t.srv.events.insert(events);
      },
    };

    const first = runSink(sinkBus([[event]]), gatedStore, new AbortController().signal, { filter });
    await insertStarted;
    const erased = await api.call('profiles.erase', { profileId, reason: 'Stalled sink insert' });
    // Replica 2 receives the redelivery while replica 1 is still stalled. Its filter now sees the
    // tombstone and drops the batch, so it acks without inserting: the ack proves nothing about
    // replica 1's earlier execution.
    await runSink(sinkBus([[event]]), gatedStore, new AbortController().signal, { filter });

    // First sweep: everything ClickHouse holds now goes, then the job waits for the final bound.
    const firstRound = await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0 });
    expect(firstRound).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });

    // Replica 1's insert lands after the first sweep. It is physically stored (the base table
    // shows it), but the publication that preceded the sweep already excludes it from every
    // protected read — this is the gap 0.17.0 closes (#1037 part 2).
    release();
    await first;
    const stored = await eventually(
      async () => {
        const rs = await t.srv.events.client.query({
          query: `SELECT event_id FROM events FINAL WHERE workspace_id = {ws:UUID} AND event_id = {id:String}`,
          query_params: { ws, id: 'dup-c2' },
          format: 'JSONEachRow',
          clickhouse_settings: await t.srv.events.settingsFor(ws),
        });
        return rs.json<{ event_id: string }>();
      },
      (rows) => rows.length > 0,
    );
    expect(stored.map((row) => row.event_id)).toContain('dup-c2');
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['dup-a'], userIds: [] })).toEqual([]);

    // The final sweep after the bound still removes the physical row, and only now is the erasure
    // complete.
    await runJobNow(erased.erasureId);
    const finalRound = await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 0, outboxWaitSeconds: 0 });
    expect(finalRound).toMatchObject({ claimed: 1, completed: 1 });
    expect((await api.call('profiles.erasureStatus', { erasureId: erased.erasureId })).status).toBe('complete');
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['dup-a'], userIds: [] })).toEqual([]);
  }, 60_000);

  it('drops a late ingested event through the running sink worker', async () => {
    const api = t.api(owner);
    const profileId = await identify(api, 'worker-a', 'worker@example.com');
    const erased = await api.call('profiles.erase', { profileId, reason: 'Running worker filter test' });
    // Complete the two-phase cleanup first; the sink filter is then the only thing standing
    // between the late ingestion below and the store.
    expect(await completeErasure(erased.erasureId)).toMatchObject({ completed: 1 });

    // Real ingestion and the real `startWorkers` sink consumer. The response means the event is
    // in the stream; wait until that consumer has read past the newest message.
    await send(t.base, key, [{ type: 'track', event: 'Page Viewed', anonymousId: 'worker-a', messageId: 'worker-late-1' }]);
    const target = (await natsConsumerState(NATS_URL, t.dbName, CLICKHOUSE_SINK_CONSUMER)).lastSequence;
    await eventually(
      async () => (await natsConsumerState(NATS_URL, t.dbName, CLICKHOUSE_SINK_CONSUMER)).ackFloor,
      (floor) => floor >= target,
      15_000,
    );
    // Without the filter wired in `startWorkers`, the consumed event would be a stored row.
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['worker-a'], userIds: [] })).toEqual([]);
  }, 60_000);

  it('completes after the final bound while unrelated events keep arriving', async () => {
    const api = t.api(owner);
    const profileId = await identify(api, 'noise-a', 'noise@example.com');
    const erased = await api.call('profiles.erase', { profileId, reason: 'Continuous ingest test' });
    const firstRound = await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0 });
    expect(firstRound).toMatchObject({ claimed: 1, deferred: 1 });

    // Steady publishing to the real bus: no stream tail is compared, so it cannot postpone the
    // erasure. (The old bus barrier required every profile shard and the sink to be empty.)
    let running = true;
    const noise = setInterval(() => {
      if (!running) return;
      void t.srv.bus.publish([busEvent('noise-b', `noise-${sequence++}`)]).catch(() => {});
    }, 25);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await runJobNow(erased.erasureId);
      const finalRound = await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 0, outboxWaitSeconds: 0 });
      expect(finalRound).toMatchObject({ claimed: 1, completed: 1 });
      expect((await api.call('profiles.erasureStatus', { erasureId: erased.erasureId })).status).toBe('complete');
    } finally {
      running = false;
      clearInterval(noise);
    }
  }, 60_000);

  it('removes a direct journey-event write that lands after the first sweep', async () => {
    const api = t.api(owner);
    const profileId = await identify(api, 'jrny-a', 'journey@example.com');
    const erased = await api.call('profiles.erase', { profileId, reason: 'Direct journey write test' });
    expect(await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0 })).toMatchObject({
      claimed: 1,
      deferred: 1,
    });

    // The journey sweeper commits its SQL, then inserts journey events directly (no outbox and no
    // sink filter). Hold it across the erasure the same way: the live-profile guard would skip a
    // write that starts now, so use the raw store to model one that passed its check before the
    // person was erased and lands after the first sweep.
    const journeyId = `jrn_erasure_final_${sequence++}`;
    const event: JourneyEvent = {
      workspaceId: ws,
      journeyId,
      version: 1,
      participantId: 1,
      profileId,
      node: 'start',
      type: 'entered',
      seq: 0,
      at: new Date().toISOString(),
      detail: '',
    };
    const raw = clickHouseStore({
      url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      database: t.dbName,
      // A direct writer hashes its subject ids, so its row is fully covered and the completion
      // gate (#1037 part 3) is about its physical presence, not a historical coverage gap.
      subjectKeys: subjectKeyHasher({ db: t.srv.db, kp: t.srv.keyProvider }),
    });
    try {
      await raw.insertJourneyEvents([event]);
    } finally {
      await raw.close();
    }
    const baseRows = async () => {
      const rs = await t.srv.events.client.query({
        query: `SELECT participant_id FROM journey_events FINAL
                 WHERE workspace_id = {ws:UUID} AND journey_id = {id:String}`,
        query_params: { ws, id: journeyId },
        format: 'JSONEachRow',
        clickhouse_settings: await t.srv.events.settingsFor(ws),
      });
      return rs.json<{ participant_id: number }>();
    };
    // The write is physically stored, but the published exclusion already hides it from every
    // application read (#1037 part 3); the final sweep below is only the physical milestone.
    expect(await baseRows()).toHaveLength(1);
    expect(await t.srv.events.journeyCounts(ws, journeyId)).toEqual([]);

    await runJobNow(erased.erasureId);
    expect(await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 0, outboxWaitSeconds: 0 })).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(await t.srv.events.journeyCounts(ws, journeyId)).toEqual([]);
    expect(await baseRows()).toEqual([]);
  }, 60_000);

  it('stores the readable events of a batch that also carries an older record without PII traits', async () => {
    const api = t.api(owner);
    const profileId = await identify(api, 'older-a', 'older@example.com');
    await api.call('profiles.erase', { profileId, reason: 'Older queued record test' });
    // The workspace now has an erasure tombstone, so the sink's filter reads every event of the
    // batch. An older queued record without its PII-traits map must not fail that read.
    const older = { ...busEvent('older-unrelated', 'older-1') } as Record<string, unknown>;
    delete older.piiTraits;
    const good = busEvent('older-good', 'older-2');

    await runSink(sinkBus([[older as unknown as BusEvent, good]]), t.srv.events, new AbortController().signal, { filter });

    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['older-good'], userIds: [] })).toHaveLength(1);
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['older-unrelated'], userIds: [] })).toEqual([]);
  }, 60_000);

  it('retries the batch when the erasure filter cannot reach its dependency', async () => {
    // A database failure is not a bad record: the batch must be delivered again, not stored short.
    const broken = erasedEventFilter({
      db: {
        admin: {
          query: async () => {
            throw new Error('database unavailable');
          },
        },
      } as unknown as Db,
      kp: t.srv.keyProvider,
    });
    await expect(
      runSink(sinkBus([[busEvent('retry-a', 'retry-1')]]), t.srv.events, new AbortController().signal, { filter: broken }),
    ).rejects.toThrow('database unavailable');
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['retry-a'], userIds: [] })).toEqual([]);
  }, 60_000);
});
