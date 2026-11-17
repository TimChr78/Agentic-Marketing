import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { clickHouseStore, type MessageEvent, messageEventCountQuery, migrateClickHouse, resetClickHouse } from '../src';

// #441: segments count the platform's own engagement (opens, clicks) from the message log. The
// store returns one count per person, narrowed by event type, window, channel, purpose and the
// broadcast or journey that sent it; the plan guard below keeps the read to the workspace's own
// parts of `message_events`.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_message_count');
const store = clickHouseStore({ url: CH_URL, database: CH_DB });

const wsA = newUuid();
const wsB = newUuid();
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const msg = (workspaceId: string, over: Partial<MessageEvent> = {}): MessageEvent => ({
  workspaceId,
  messageId: `msg_${newUuid()}`,
  eventId: `evt_${newUuid()}`,
  type: 'opened',
  at: daysAgo(1),
  profileId: 'prf_ada',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: '',
  templateVersion: 1,
  journeyId: 'bct_newsletter',
  reason: '',
  url: '',
  ...over,
});

/** A stable id per row, so a re-insert of the same event is the dedupe case, not a second event. */
const stable = (workspaceId: string, profileId: string, type: string, at: string) => ({
  messageId: `msg_${workspaceId.slice(0, 8)}_${profileId}_${type}_${at}`,
  eventId: `evt_${workspaceId.slice(0, 8)}_${profileId}_${type}_${at}`,
});

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
}, 120_000);

afterAll(async () => {
  await store.close();
});

async function seedEngagement() {
  const rows: MessageEvent[] = [];
  const add = (ws: string, profileId: string, type: MessageEvent['type'], at: string, over: Partial<MessageEvent> = {}) =>
    rows.push(msg(ws, { profileId, type, at, ...stable(ws, profileId, type, at), ...over }));
  for (const ws of [wsA, wsB]) {
    // Ada opened three times inside 30 days and once 40 days ago.
    add(ws, 'prf_ada', 'opened', daysAgo(1));
    add(ws, 'prf_ada', 'opened', daysAgo(2));
    add(ws, 'prf_ada', 'opened', daysAgo(3));
    add(ws, 'prf_ada', 'opened', daysAgo(40));
    add(ws, 'prf_ada', 'clicked', daysAgo(5), { url: 'https://example.com/a' });
    // Bo opened once, from a journey, and got one SMS delivered.
    add(ws, 'prf_bo', 'opened', daysAgo(4), { journeyId: 'jrn_welcome' });
    add(ws, 'prf_bo', 'delivered', daysAgo(2), { channel: 'sms', purpose: 'marketing_sms', journeyId: 'bct_newsletter' });
    // Cy was delivered a transactional message on e-mail.
    add(ws, 'prf_cy', 'delivered', daysAgo(1), { purpose: 'onboarding' });
  }
  await store.insertMessageEvents(rows);
}

describe('message event counts', () => {
  beforeAll(seedEngagement, 60_000);

  it('counts a type per person inside the window, for one workspace only', async () => {
    const a = await store.countMessageEvents(wsA, { type: 'opened', sinceSeconds: 30 * 86_400 });
    expect(Object.fromEntries(a.map((r) => [r.profileId, r.count]))).toEqual({ prf_ada: 3, prf_bo: 1 });
    // The other workspace has the same shape of data and must not leak into this one.
    expect(await store.countMessageEvents(newUuid(), { type: 'opened' })).toEqual([]);
    // Without a window the 40-day-old open counts too.
    expect((await store.countMessageEvents(wsA, { type: 'opened' })).find((r) => r.profileId === 'prf_ada')?.count).toBe(4);
  });

  it('narrows by channel, purpose and the send the messages came from', async () => {
    expect(await store.countMessageEvents(wsA, { type: 'delivered', channel: 'sms' })).toEqual([{ profileId: 'prf_bo', count: 1 }]);
    expect(await store.countMessageEvents(wsA, { type: 'delivered', purpose: 'onboarding' })).toEqual([{ profileId: 'prf_cy', count: 1 }]);
    expect(await store.countMessageEvents(wsA, { type: 'opened', sentBy: 'jrn_welcome' })).toEqual([{ profileId: 'prf_bo', count: 1 }]);
    expect(await store.countMessageEvents(wsA, { type: 'opened', sentBy: 'bct_newsletter' })).toEqual([{ profileId: 'prf_ada', count: 4 }]);
  });

  it('scopes to the people being checked and handles an empty scope', async () => {
    expect(await store.countMessageEvents(wsA, { type: 'opened', profileIds: ['prf_bo'] })).toEqual([{ profileId: 'prf_bo', count: 1 }]);
    expect(await store.countMessageEvents(wsA, { type: 'opened', profileIds: [] })).toEqual([]);
  });

  it('counts a retried provider event once (FINAL)', async () => {
    const [first] = await store.countMessageEvents(wsA, { type: 'clicked' });
    // The same message, type and event id replaces the earlier row instead of adding to it.
    await store.insertMessageEvents([
      msg(wsA, { profileId: 'prf_ada', type: 'clicked', at: daysAgo(5), ...stable(wsA, 'prf_ada', 'clicked', daysAgo(5)) }),
    ]);
    expect(await store.countMessageEvents(wsA, { type: 'clicked' })).toEqual([{ profileId: first!.profileId, count: first!.count }]);
  });

  it('streams the counts in batches for a whole workspace', async () => {
    const sizes: number[] = [];
    for await (const batch of store.countMessageEventsBatches(wsA, { type: 'opened' }, 1)) sizes.push(batch.length);
    expect(sizes).toEqual([1, 1]);
  });
});

describe('the message count plan', () => {
  // A workspace's messages and another workspace's, in separate inserts and different months, so
  // the primary key (which starts with workspace_id) can skip the parts that hold only someone
  // else's messages.
  beforeAll(async () => {
    for (const month of [0, 1, 2, 3, 5, 8]) {
      const at = daysAgo(month * 30 + 6);
      await store.insertMessageEvents(
        Array.from({ length: 500 }, (_, i) => msg(wsA, { profileId: `prf_${i}`, at, ...stable(wsA, `prf_${i}`, 'opened', at) })),
      );
      await store.insertMessageEvents(
        Array.from({ length: 500 }, (_, i) => msg(wsB, { profileId: `prf_${i}`, at, ...stable(wsB, `prf_${i}`, 'opened', at) })),
      );
    }
  }, 120_000);

  it('reads only the workspace’s own parts of message_events', async () => {
    const q = messageEventCountQuery(wsA, { type: 'opened', sinceSeconds: 30 * 86_400 });
    const rs = await store.client.query({
      query: `EXPLAIN indexes = 1 ${q.query}`,
      query_params: q.query_params,
      format: 'TabSeparatedRaw',
      clickhouse_settings: (await store.settingsFor(wsA)) as never,
    });
    const plan = await rs.text();
    expect(plan).toContain('message_events');
    expect(plan).toContain('FINAL: 1');
    // Every index entry prints "Parts: selected/initial": the workspace filter must skip some.
    const parts = [...plan.matchAll(/Parts: (\d+)\/(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some(([selected, initial]) => selected < initial)).toBe(true);
  });
});
