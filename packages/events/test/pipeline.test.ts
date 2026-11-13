import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
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
const NS = runScoped('test_events_pkg');
const CH_DB = runScoped('am_test_events');
const ws = newUuid();

let bus: EventBus;
const store = clickHouseStore({ url: CH_URL, database: CH_DB });
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
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  bus = await natsBus({ url: NATS_URL, namespace: NS });
});

afterAll(async () => {
  stop.abort();
  await bus?.close();
  await store.close();
  // This namespace is not a database name, so global teardown cannot infer it. Remove its stream
  // and consumers explicitly, after the bus's own connection has drained.
  await resetNatsNamespace(NATS_URL, NS);
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

describe('conversion paging', () => {
  it('pages conversions that tie on timestamp and event id without skipping either (#786)', async () => {
    const tieWs = newUuid();
    const at = '2026-10-02T12:00:00.000Z';
    const first = ev(200, {
      workspaceId: tieWs,
      messageId: 'conversion-tie',
      name: 'Tie Purchase',
      timestamp: at,
      receivedAt: at,
      anonymousId: 'tie-a',
    });
    // The replacing key includes anonymous_id, so both rows survive FINAL even though timestamp
    // and event_id are identical. A strict (timestamp, event_id) cursor assumed otherwise and
    // dropped the second at a page boundary; the reviewer reproduced 2 rows with pageSize 1
    // returning 1.
    await store.insert([first, { ...first, anonymousId: 'tie-b' }]);
    const from = new Date('2026-10-02T00:00:00.000Z');
    const to = new Date('2026-10-02T23:59:59.999Z');
    expect(await store.conversionEvents(tieWs, { names: ['Tie Purchase'], from, to })).toHaveLength(2);
    const paged = await store.conversionEvents(tieWs, { names: ['Tie Purchase'], from, to, pageSize: 1 });
    expect(paged.map((e) => e.anonymousId).sort()).toEqual(['tie-a', 'tie-b']);
  });
});

describe('event paging', () => {
  it('pages eventsOf on the full replacing key, so tied events are not skipped (#840)', async () => {
    const tieWs = newUuid();
    const at = '2026-10-04T12:00:00.000Z';
    const tied = (anonymousId: string, name: string) =>
      ev(400, { workspaceId: tieWs, messageId: 'tie-event', name, timestamp: at, receivedAt: at, anonymousId });
    // Same timestamp and event id throughout; the name and anonymous id are what tell them apart.
    await store.insert([tied('page-a', 'Tie Event'), tied('page-b', 'Tie Event'), tied('page-a', 'Tie Other')]);
    const ids = { anonymousIds: ['page-a', 'page-b'], userIds: [] };
    const key = (e: { name: string; anonymousId: string }) => `${e.name}:${e.anonymousId}`;
    const all = ['Tie Event:page-a', 'Tie Event:page-b', 'Tie Other:page-a'];

    const seen: string[] = [];
    let cursor: { before: string; beforeId: string; beforeName: string; beforeAnonymousId: string } | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await store.eventsOf(tieWs, ids, { limit: 1, ...(cursor ?? {}) });
      if (!page.length) break;
      const last = page[0]!;
      seen.push(key(last));
      cursor = { before: last.timestamp, beforeId: last.eventId, beforeName: last.name, beforeAnonymousId: last.anonymousId };
    }
    expect(seen.sort()).toEqual(all);

    // A cursor written before #840 has no name or anonymous id. It falls back to the old
    // (timestamp, event_id) tuple, which always makes progress: here it starts strictly before the
    // boundary row, so the tied rows at that key are skipped exactly as they were before #840
    // rather than returned forever.
    const [first] = await store.eventsOf(tieWs, ids, { limit: 1 });
    expect(first).toBeDefined();
    const oldCursor = await store.eventsOf(tieWs, ids, {
      limit: 10,
      before: first!.timestamp,
      beforeId: first!.eventId,
    });
    expect(oldCursor).toEqual([]);
  });

  it('advances an old-format cursor through tied timestamps instead of repeating the page (#840 follow-up)', async () => {
    const legacyWs = newUuid();
    const at = '2026-10-06T12:00:00.000Z';
    const legacy = (eventId: string) =>
      ev(600, { workspaceId: legacyWs, messageId: eventId, name: 'Legacy Event', timestamp: at, receivedAt: at, anonymousId: 'legacy-a' });
    await store.insert([legacy('event-c'), legacy('event-b'), legacy('event-a')]);
    const ids = { anonymousIds: ['legacy-a'], userIds: [] };

    // A client that forwards only the timestamp and event id, as pre-#840 nextCursor did. The old
    // reader ignored beforeId and used `timestamp <= before`, so with two events per page it
    // returned [c, b] on every call and never reached a.
    const seen: string[] = [];
    let cursor: { before: string; beforeId: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await store.eventsOf(legacyWs, ids, { limit: 2, ...(cursor ?? {}) });
      if (!page.length) break;
      seen.push(...page.map((event) => event.eventId));
      const last = page[page.length - 1]!;
      cursor = { before: last.timestamp, beforeId: last.eventId };
    }
    expect(seen).toEqual(['event-c', 'event-b', 'event-a']);

    // A client that forwards the full cursor still sees every event, once.
    const full: string[] = [];
    let next: { before: string; beforeId: string; beforeName: string; beforeAnonymousId: string } | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await store.eventsOf(legacyWs, ids, { limit: 2, ...(next ?? {}) });
      if (!page.length) break;
      full.push(...page.map((event) => event.eventId));
      const last = page[page.length - 1]!;
      next = { before: last.timestamp, beforeId: last.eventId, beforeName: last.name, beforeAnonymousId: last.anonymousId };
    }
    expect(full).toEqual(['event-c', 'event-b', 'event-a']);
  });
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
