import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { clickHouseStore, type MessageEvent, messageEventsWithPending, migrateClickHouse, resetClickHouse } from '../src';

// #1008: a decision that reads the metric layer before the outbox published can hand the queued
// events to the same query. The snapshot must not double-count an event that the dispatcher
// published in between: the union de-duplicates on the table's replacing key.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_pending_events');
const ws = newUuid();
const store = clickHouseStore({ url: CH_URL, database: CH_DB });
const since = new Date('2026-10-01T00:00:00.000Z');

const event = (over: Partial<MessageEvent> & Pick<MessageEvent, 'messageId' | 'eventId' | 'type' | 'profileId'>): MessageEvent => ({
  workspaceId: ws,
  at: '2026-10-01T12:00:00.000Z',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: `eml_${'a'.repeat(32)}`,
  templateVersion: 1,
  journeyId: `bct_${'b'.repeat(32)}`,
  variant: '',
  reason: '',
  url: '',
  ...over,
});

const M1 = 'msg_pending_1';
const M2 = 'msg_pending_2';
const M3 = 'msg_pending_3';
const P1 = `prf_${'1'.repeat(32)}`;
const P2 = `prf_${'2'.repeat(32)}`;
const P3 = `prf_${'3'.repeat(32)}`;

/** Rows in the union source, so a double count is visible where a distinct count would hide it. */
async function rowCount(rows: readonly MessageEvent[]) {
  const params: Record<string, unknown> = { ws };
  const result = await store.client.query({
    query: `SELECT count() AS n FROM ${messageEventsWithPending(rows, params)} WHERE workspace_id = {ws:UUID}`,
    query_params: params,
    clickhouse_settings: (await store.settingsFor(ws)) as never,
    format: 'JSONEachRow',
  });
  return Number((await result.json<{ n: string | number }>())[0]?.n ?? 0);
}

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
}, 60_000);

afterAll(async () => {
  await store?.close();
});

describe('message events with a pending snapshot (#1008)', () => {
  it('reads published events plus the queued ones and counts an event in both once', async () => {
    await store.insertMessageEvents([
      event({ messageId: M1, eventId: 'sent:1', type: 'sent', profileId: P1 }),
      event({ messageId: M2, eventId: 'complaint:2', type: 'complained', profileId: P2 }),
    ]);
    // M1's sent event was published while the decision took its snapshot; the rest are queued.
    const pending = [
      event({ messageId: M1, eventId: 'sent:1', type: 'sent', profileId: P1 }),
      event({ messageId: M2, eventId: 'bounce:2', type: 'bounced', profileId: P2 }),
      event({ messageId: M3, eventId: 'sent:3', type: 'sent', profileId: P3 }),
    ];

    // Two published + two queued, with the duplicate de-duplicated on (message, type, event id).
    expect(await rowCount(pending)).toBe(4);
    expect(await rowCount([])).toBe(2);

    // The same aggregation sees both halves: distinct messages per type, exactly as after publication.
    const withPending = await store.messageStats(ws, { since, messageIds: [M1, M2, M3], pendingEvents: pending });
    expect(withPending).toMatchObject({ sent: 2, complained: 1, bounced: 1 });
    const publishedOnly = await store.messageStats(ws, { since, messageIds: [M1, M2, M3] });
    expect(publishedOnly).toMatchObject({ sent: 1, complained: 1 });
    expect(publishedOnly.bounced ?? 0).toBe(0);
  });

  it('keeps the plain table when nothing is queued', () => {
    expect(messageEventsWithPending([], { ws })).toBe('message_events_protected(ws={ws:UUID}) FINAL');
  });

  it('leaves everything outside the snapshot out of the count', async () => {
    // A queued event for another message must not leak into a read scoped to these messages.
    const pending = [event({ messageId: 'msg_other', eventId: 'sent:9', type: 'sent', profileId: P3 })];
    const stats = await store.messageStats(ws, { since, messageIds: [M1, M2, M3], pendingEvents: pending });
    expect(stats.sent).toBe(1);
  });
});
