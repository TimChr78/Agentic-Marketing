import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BusEvent,
  clickHouseStore,
  correctedTimestamp,
  type EventBus,
  InboundEvent,
  migrateClickHouse,
  natsBus,
  resetClickHouse,
  resetNatsNamespace,
  runSink,
} from '../src';

const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const NS = 'test_events_pkg';
const ws = newUuid();

let bus: EventBus;
const store = clickHouseStore({ url: CH_URL, database: 'am_test_events' });
const stop = new AbortController();

const ev = (i: number, over: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_test',
  messageId: `m-${i}`,
  type: 'track',
  name: 'product_viewed',
  anonymousId: `anon-${i % 3}`,
  userId: '',
  timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(),
  receivedAt: new Date().toISOString(),
  properties: { sku: `SKU-${i}`, price: 100 + i },
  traits: {},
  piiTraits: { email: 'never-stored@example.com' },
  context: { page: { path: '/p' } },
  consent: { analytics: true },
  ...over,
});

beforeAll(async () => {
  await resetNatsNamespace(NATS_URL, NS);
  await resetClickHouse(CH_URL, 'am_test_events');
  await migrateClickHouse(CH_URL, 'am_test_events');
  bus = await natsBus({ url: NATS_URL, namespace: NS });
});

afterAll(async () => {
  stop.abort();
  await bus?.close();
  await store.close();
});

describe('Segment event schema', () => {
  it('accepts the spec shapes and requires an identity', () => {
    expect(InboundEvent.safeParse({ type: 'track', event: 'Order Completed', anonymousId: 'a' }).success).toBe(true);
    expect(InboundEvent.safeParse({ type: 'identify', userId: 'u1', traits: { email: 'x@example.com' } }).success).toBe(true);
    expect(InboundEvent.safeParse({ type: 'track', event: 'x' }).success).toBe(false);
    expect(InboundEvent.safeParse({ type: 'launch', anonymousId: 'a' }).success).toBe(false);
  });

  it('corrects client clock skew with sentAt', () => {
    const received = new Date('2026-10-01T12:00:10Z');
    const e = InboundEvent.parse({
      type: 'track',
      event: 'x',
      anonymousId: 'a',
      timestamp: '2030-01-01T00:00:00Z',
      sentAt: '2030-01-01T00:00:04Z',
    });
    expect(correctedTimestamp(e, received).toISOString()).toBe('2026-10-01T12:00:06.000Z');
    const future = InboundEvent.parse({ type: 'track', event: 'x', anonymousId: 'a', timestamp: '2030-01-01T00:00:00Z' });
    expect(correctedTimestamp(future, received)).toEqual(received);
  });
});

describe('bus → ClickHouse sink', () => {
  it('stores published events within seconds, drops duplicate message ids, and finds a person’s events', async () => {
    void runSink(bus, store, stop.signal, { name: 'test-sink' });
    const first = await bus.publish(Array.from({ length: 30 }, (_, i) => ev(i)));
    expect(first).toEqual({ accepted: 30, duplicates: 0 });
    expect((await bus.publish([ev(0), ev(1)])).duplicates).toBe(2);

    const started = Date.now();
    let found: Awaited<ReturnType<typeof store.eventsOf>> = [];
    while (Date.now() - started < 10_000) {
      found = await store.eventsOf(ws, { anonymousIds: ['anon-1'], userIds: [] }, { limit: 50 });
      if (found.length === 10) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(found).toHaveLength(10);
    expect(found[0]).toMatchObject({ eventId: 'm-28', name: 'product_viewed', properties: { sku: 'SKU-28', price: 128 } });
    expect(Date.now() - started).toBeLessThan(5_000);

    await store.deleteEventsOf(ws, { anonymousIds: ['anon-1'], userIds: [] });
    expect(await store.eventsOf(ws, { anonymousIds: ['anon-1'], userIds: [] })).toHaveLength(0);
    expect(await store.eventsOf(ws, { anonymousIds: ['anon-2'], userIds: [] })).toHaveLength(10);
  }, 20_000);
});

describe('row policies', () => {
  it('shows a query only the rows of the workspace it names, and none without one', async () => {
    const other = newUuid();
    await store.insert([ev(100, { workspaceId: other, messageId: 'other-1', anonymousId: 'anon-x' })]);
    const count = async (settings: Record<string, string>) =>
      Number(
        (
          await (
            await store.client.query({
              query: 'SELECT count() AS c FROM events',
              format: 'JSONEachRow',
              clickhouse_settings: settings as never,
            })
          ).json<{ c: number }>()
        )[0].c,
      );
    // Deliberately unfiltered SQL: the policy alone decides what it returns.
    expect(await count({})).toBe(0);
    expect(await count(await store.settingsFor(other))).toBe(1);
    expect(await count(await store.settingsFor(ws))).toBeGreaterThan(1);
    expect(await store.countEvents(other, { name: 'product_viewed' })).toEqual([{ anonymousId: 'anon-x', userId: '', count: 1 }]);
    const batches = [];
    for await (const b of store.countEventsBatches(ws, { name: 'product_viewed' }, 1)) batches.push(b);
    expect(batches.length).toBe(2); // anon-0 and anon-2 (anon-1 was erased above)
  });
});
