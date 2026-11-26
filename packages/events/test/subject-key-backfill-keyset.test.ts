import { newUuid } from '@agentic-marketing/core';
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { cursorPredicate, migrateClickHouse, resetClickHouse, SUBJECT_KEY_BACKFILL_TABLES, subjectKeyBackfillBatchQuery } from '../src';

// #1226: the subject-key backfill pages a table with a keyset over its whole sort key. Written as a
// tuple comparison, `(workspace_id, name, …) > (…, …)`, ClickHouse's primary-key analysis does not
// use it to choose granules, so every batch read the workspace's whole range with FINAL and all
// columns. The expanded column comparisons select the same rows and let the server start at the
// cursor. These tests pin both the predicate shape and the rows a batch actually reads.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_events_backfill_keyset');
const EVENTS = SUBJECT_KEY_BACKFILL_TABLES[0]!;
const ws = newUuid();
const TOTAL = 30_000;
const BATCH = 5_000;

let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  client = createClient({ url: CH_URL, database: CH_DB, clickhouse_settings: { date_time_input_format: 'best_effort' } });
  // Historical rows as a pre-0.17.0 writer left them: no subject columns at all.
  for (let offset = 0; offset < TOTAL; offset += 10_000) {
    await client.insert({
      table: 'events',
      values: Array.from({ length: 10_000 }, (_, i) => {
        const n = offset + i;
        return {
          workspace_id: ws,
          event_id: `ev-${n}`,
          source_id: 'src_keyset',
          received_at: '2026-05-01 12:00:00',
          timestamp: '2026-05-01 12:00:00',
          type: 'track',
          name: `Event ${String(n % 500).padStart(3, '0')}`,
          anonymous_id: `anon-${n}`,
          user_id: '',
          profile_id: `prf-${n}`,
          properties: {},
          traits: {},
          context: {},
          consent: {},
        };
      }),
      format: 'JSONEachRow',
    });
  }
  // One merged part, the shape a long-lived table has; unmerged parts only read more.
  await client.command({ query: 'OPTIMIZE TABLE events FINAL' });
}, 300_000);

afterAll(async () => {
  await client?.close();
});

describe('subject-key backfill keyset predicate (#1226)', () => {
  it('expands the tuple comparison into the column comparisons ClickHouse can prune with', () => {
    const cursor = JSON.stringify({
      workspace_id: ws,
      name: 'Event 250',
      anonymous_id: 'anon-250',
      timestamp: '2026-05-01 12:00:00.000',
      event_id: 'ev-250',
    });
    const { sql, params } = cursorPredicate(EVENTS, cursor);
    // No tuple form: that is the shape the server does not analyse.
    expect(sql).not.toContain(') > (');
    expect(sql).not.toMatch(/\((?:t\.[a-z_]+(?:, )?)+\) > \(/);
    // Expanded, step by step down the sort key.
    expect(sql).toContain('t.workspace_id > {c0:UUID}');
    expect(sql).toMatch(/t\.workspace_id = \{c0:UUID\} AND \(t\.name > \{c1:String\}/);
    expect(sql).toMatch(/t\.name = \{c1:String\} AND \(t\.anonymous_id > \{c2:String\}/);
    expect(sql).toMatch(/t\.anonymous_id = \{c2:String\} AND \(t\.timestamp > \{c3:DateTime64\(3, 'UTC'\)\}/);
    expect(sql).toMatch(/t\.timestamp = \{c3:DateTime64\(3, 'UTC'\)\} AND t\.event_id > \{c4:String\}/);
    expect(params).toMatchObject({ c0: ws, c1: 'Event 250', c2: 'anon-250', c3: '2026-05-01 12:00:00.000', c4: 'ev-250' });
    // An empty cursor still asks for the first batch.
    expect(cursorPredicate(EVENTS, '')).toEqual({ sql: '', params: {} });
  });

  it('reads about one granule for a batch near the end of the table, not the whole table', async () => {
    // The cursor is the last row in sort order: the old tuple form still read all 30,000 rows for a
    // batch that has nothing after it; the expanded form starts at the cursor's granule.
    const last = await (
      await client.query({
        query: `SELECT name, anonymous_id, timestamp, event_id FROM events FINAL
                WHERE workspace_id = {ws:UUID} ORDER BY name DESC, anonymous_id DESC, timestamp DESC, event_id DESC LIMIT 1`,
        query_params: { ws },
        format: 'JSONEachRow',
        // The migration applies the workspace row policy in auto mode, as a small install does.
        clickhouse_settings: { SQL_workspace: ws },
      })
    ).json<Array<{ name: string; anonymous_id: string; timestamp: string; event_id: string }>>();
    expect(last).toHaveLength(1);
    const cursor = JSON.stringify({ workspace_id: ws, ...last[0] });
    const batch = subjectKeyBackfillBatchQuery(EVENTS, { workspaceId: ws, cursor, limit: BATCH });
    const readRows = async (query: string) => {
      const result = await client.query({
        query,
        query_params: batch.query_params,
        format: 'JSONEachRow',
        clickhouse_settings: { SQL_workspace: ws },
      });
      await result.json();
      const header = result.response_headers['x-clickhouse-summary'];
      const summary = JSON.parse((Array.isArray(header) ? header[0] : header) ?? '{}') as { read_rows?: string };
      return Number(summary.read_rows);
    };
    const expanded = await readRows(batch.query);
    // The form this replaced, over the same cursor: the server reads the whole workspace range
    // because it cannot use the tuple for granule selection.
    const tuple = `AND (${EVENTS.sortColumns.map((c) => `t.${c.name}`).join(', ')}) > (${EVENTS.sortColumns
      .map((c, i) => `{c${i}:${c.type}}`)
      .join(', ')})`;
    const head = batch.query.slice(0, batch.query.indexOf('AND (t.workspace_id >'));
    const controlQuery = `${head}${tuple} ${batch.query.slice(batch.query.indexOf('\n            ORDER BY'))}`;
    const control = await readRows(controlQuery);

    expect(Number.isFinite(expanded)).toBe(true);
    expect(control).toBe(TOTAL);
    expect(expanded).toBeLessThan(TOTAL / 2);
    expect(expanded).toBeLessThan(control);
  }, 300_000);
});
