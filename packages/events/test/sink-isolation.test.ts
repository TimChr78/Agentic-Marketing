import { createHmac } from 'node:crypto';
import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import {
  type BusEvent,
  type ConsumerOptions,
  clickHouseStore,
  consumeLoop,
  type EventBus,
  type EventStore,
  type FetchedMessage,
  type MessageBatch,
  migrateClickHouse,
  type PullConsumer,
  resetClickHouse,
  runSink,
  type SubjectKeyHasher,
  type SubjectKeyKind,
} from '../src';

// The sink inserts a whole batch or nothing: one event the store cannot read must not keep every
// other event (of any workspace) out of ClickHouse, because JetStream re-delivers a nak'd batch
// until the stream's max age.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_sink_isolation');
const KEY = Buffer.alloc(32, 41);

const hasher: SubjectKeyHasher = {
  version: 'dk_sink_isolation_test',
  async hash(kind: SubjectKeyKind, value: string) {
    return createHmac('sha256', KEY).update(`${kind}:${value}`).digest('hex');
  },
  dispose() {},
};
const factory = async () => hasher;

let store: EventStore;

const event = (workspaceId: string, id: string, over: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId,
  sourceId: 'src_sink_isolation',
  messageId: id,
  type: 'track',
  name: 'Sink Isolation',
  anonymousId: `${id}-anon`,
  userId: '',
  profileId: `${id}-prf`,
  timestamp: '2026-11-02T12:00:00.000Z',
  receivedAt: '2026-11-02T12:00:00.000Z',
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const encode = (e: BusEvent) => new TextEncoder().encode(JSON.stringify(e));
const decode = (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as BusEvent;
const batch = (messages: FetchedMessage[]): MessageBatch =>
  (async function* () {
    yield* messages;
  })();

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
}, 120_000);

afterAll(async () => {
  await store?.close();
});

describe('sink batch isolation', () => {
  it('stores the readable events of a batch that also carries events it cannot read', async () => {
    const poisonWs = newUuid();
    const unreadableWs = newUuid();
    const goodWs = newUuid();
    // A client-supplied context of the wrong shape, as a server-side integration can send it.
    const poison = event(poisonWs, 'poison', { context: { page: { url: 5 } } });
    // A payload the store cannot turn into a row at all (an older or corrupt queued event).
    const unreadable = { ...event(unreadableWs, 'unreadable'), receivedAt: null } as unknown as BusEvent;
    const good = event(goodWs, 'good', { context: { page: { url: 'https://shop.test/landing?gclid=abc123' } } });

    const acks = { count: 0 };
    const naks = { count: 0 };
    const messages: FetchedMessage[] = [poison, unreadable, good].map((e) => ({
      data: encode(e),
      ack: () => {
        acks.count += 1;
      },
      nak: () => {
        naks.count += 1;
      },
    }));
    const stop = new AbortController();
    let fetches = 0;
    const consumer: PullConsumer = {
      fetch: async () => {
        fetches += 1;
        // One delivery of the batch, then an empty pull that ends the loop when it is stopped.
        if (fetches > 1) {
          stop.abort();
          return batch([]);
        }
        return batch(messages);
      },
    };
    const bus = {
      consume: (o: ConsumerOptions, handler: (events: BusEvent[]) => Promise<void>, signal: AbortSignal) =>
        // One fetch per iteration, so the second pull is the start of a new delivery.
        consumeLoop(async () => consumer, { ...o, maxWaitMs: 0 }, decode, handler, signal),
    } as unknown as EventBus;

    await runSink(bus, store, stop.signal);

    // The batch was acked, not nak'd for another delivery.
    expect(naks.count).toBe(0);
    expect(acks.count).toBe(3);
    expect(await store.eventsOf(goodWs, { anonymousIds: ['good-anon'], userIds: [] })).toHaveLength(1);
    expect(await store.eventsOf(poisonWs, { anonymousIds: ['poison-anon'], userIds: [] })).toHaveLength(1);
    expect(await store.eventsOf(unreadableWs, { anonymousIds: ['unreadable-anon'], userIds: [] })).toHaveLength(0);
  }, 120_000);
});
