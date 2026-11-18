import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { clickHouseStore, type EventStore, migrateClickHouse, resetClickHouse } from '../src';

// #1037 part 2 memory and fast-path regression. A workspace's exclusion ledger is permanent, so a
// read shape that materialises it once per row eventually fails for ordinary queries: with 100,000
// exclusion hashes a filtered count over a workspace exhausted a 10 GiB allocation. The protected
// views build the workspace's ledger as one set per query and test the row's subject keys against
// it; the shared read layer skips the view entirely for a workspace whose durable `erasure_keys`
// ledger has no row. This test pins both: 1.2M events over 12 workspaces, a 100,000-row ledger in one, and a
// 1 GiB per-query limit.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_protected_bench');
const WORKSPACES = 12;
const PER_WORKSPACE = 100_000;
const EVENTS = WORKSPACES * PER_WORKSPACE;
const uuidOf = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const ERASED_WORKSPACE = uuidOf(7);
const CLEAN_WORKSPACE = uuidOf(8);
const MEMORY_LIMIT = 1 << 30;
const WINDOW = `name = 'Purchase' AND timestamp >= toDateTime64('2026-11-01 00:30:00', 3)`;

let store: EventStore;

/** The `X-ClickHouse-Summary` a query returned, as numbers. */
async function counted(sql: string, workspace: string): Promise<{ count: number; memory: number; elapsedMs: number; readRows: number }> {
  const result = await store.client.query({
    query: sql,
    query_params: { ws: workspace },
    format: 'JSONEachRow',
    clickhouse_settings: {
      ...(await store.settingsFor(workspace)),
      // A modest bound: the pre-fix shape needed 10 GiB here. The server refuses anything above it.
      max_memory_usage: MEMORY_LIMIT,
    } as never,
  });
  const [row] = await result.json<{ n: number | string }>();
  const summary = JSON.parse(
    (result as unknown as { response_headers?: Record<string, string> }).response_headers?.['x-clickhouse-summary'] ?? '{}',
  ) as { memory_usage?: string; elapsed_ns?: string; read_rows?: string };
  return {
    count: Number(row?.n ?? 0),
    memory: Number(summary.memory_usage ?? 0),
    elapsedMs: Number(summary.elapsed_ns ?? 0) / 1e6,
    readRows: Number(summary.read_rows ?? 0),
  };
}

const countOf = (source: string) => `SELECT count() AS n FROM ${source} WHERE workspace_id = {ws:UUID} AND ${WINDOW}`;

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({
    url: CH_URL,
    database: CH_DB,
    // The benchmark drives both sources explicitly; the store's read methods use the protected one.
    hasErasures: async () => true,
  });
  // One workspace per 100k consecutive rows. Every row is `coverage = 'full'` with its own profile
  // hash, and every row also has a side-table entry: the worst case for the identity join.
  await store.client.command({
    query: `INSERT INTO events (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                                anonymous_id, user_id, profile_id, properties, traits, context, consent,
                                subject_coverage, subject_profile)
            SELECT toUUID(concat('00000000-0000-0000-0000-', leftPad(toString(intDiv(number, ${PER_WORKSPACE})), 12, '0'))),
                   toString(number), 'src_bench',
                   toDateTime64('2026-11-01', 3) + toIntervalSecond(number % 3600),
                   toDateTime64('2026-11-01', 3) + toIntervalSecond(number % 3600),
                   'track', 'Purchase', toString(number % 10000), '', toString(number),
                   '{}', '{}', '{}', map(), 'full', hex(SHA256(toString(number)))
            FROM numbers(${EVENTS})`,
  });
  // The person tables are behind workspace row policies, so a seed read of `events` names its
  // workspace like any application read does.
  for (let index = 0; index < WORKSPACES; index++) {
    const workspace = uuidOf(index);
    await store.client.command({
      query: `INSERT INTO subject_key_backfill (table_name, workspace_id, key1, key2, key3, key4, subject_profile, subject_coverage)
              SELECT 'events', workspace_id, name, anonymous_id, toString(timestamp), event_id, subject_profile, 'full'
              FROM events WHERE workspace_id = toUUID({ws:String})`,
      query_params: { ws: workspace },
      clickhouse_settings: await store.settingsFor(workspace),
    });
  }
  // 100,000 exclusions in workspace 7: 25,000 real profile hashes (every fourth row) plus 75,000
  // hashes that match nothing, so the ledger is large while rows survive the filter.
  await store.client.command({
    query: `INSERT INTO erased_subjects (workspace_id, kind, key, key_version, erasure_id, generation, recorded_at)
            SELECT toUUID({ws:String}), 'profile', subject_profile, 'dk_bench', 'era_bench', 1, now64(3)
            FROM events
            WHERE workspace_id = toUUID({ws:String}) AND profile_id != '' AND toInt64(profile_id) % 4 = 0`,
    query_params: { ws: ERASED_WORKSPACE },
    clickhouse_settings: await store.settingsFor(ERASED_WORKSPACE),
  });
  await store.client.command({
    query: `INSERT INTO erased_subjects (workspace_id, kind, key, key_version, erasure_id, generation, recorded_at)
            SELECT toUUID({ws:String}), 'profile', hex(SHA256(concat('absent-', toString(number)))), 'dk_bench', 'era_bench', 1, now64(3)
            FROM numbers(75000)`,
    query_params: { ws: ERASED_WORKSPACE },
  });
}, 300_000);

afterAll(async () => {
  await store?.close();
  // 1.2M seeded rows: remove them rather than leave a benchmark-sized database behind.
  await resetClickHouse(CH_URL, CH_DB).catch(() => {});
});

describe('protected reads have a bounded memory shape (#1037 part 2)', () => {
  it('counts a 100,000-key ledger under a 1 GiB query limit, and reports the base ratio', async () => {
    const ledger = await counted(`SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}`, ERASED_WORKSPACE);
    expect(ledger.count).toBe(100_000);

    const base = await counted(countOf('events FINAL'), ERASED_WORKSPACE);
    const protectedResult = await counted(countOf('events_protected(ws={ws:UUID}) FINAL'), ERASED_WORKSPACE);
    // The reference: the same rows minus the erased profile hashes, computed without the view.
    const reference = await counted(
      `SELECT count() AS n FROM events FINAL
        WHERE workspace_id = {ws:UUID} AND ${WINDOW}
          AND subject_profile NOT IN (
            SELECT key FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID} AND kind = 'profile')`,
      ERASED_WORKSPACE,
    );
    expect(base.count).toBeGreaterThan(50_000);
    expect(protectedResult.count).toBe(reference.count);
    expect(protectedResult.count).toBeLessThan(base.count);
    expect(protectedResult.memory).toBeLessThan(MEMORY_LIMIT / 2);
    console.log(
      'protected-reads benchmark: ' +
        JSON.stringify({
          events: EVENTS,
          workspaces: WORKSPACES,
          ledger: ledger.count,
          baseRows: base.readRows,
          protectedRows: protectedResult.readRows,
          readRatio: Number((protectedResult.readRows / base.readRows).toFixed(2)),
          baseMs: Number(base.elapsedMs.toFixed(1)),
          protectedMs: Number(protectedResult.elapsedMs.toFixed(1)),
          baseMiB: Number((base.memory / 2 ** 20).toFixed(1)),
          protectedMiB: Number((protectedResult.memory / 2 ** 20).toFixed(1)),
          survivors: protectedResult.count,
        }),
    );
  }, 300_000);

  it('stays proportional for a workspace with an empty ledger', async () => {
    const base = await counted(countOf('events FINAL'), CLEAN_WORKSPACE);
    const protectedResult = await counted(countOf('events_protected(ws={ws:UUID}) FINAL'), CLEAN_WORKSPACE);
    expect(protectedResult.count).toBe(base.count);
    expect(protectedResult.memory).toBeLessThan(MEMORY_LIMIT / 2);
    console.log(
      'protected-reads benchmark (empty ledger): ' +
        JSON.stringify({
          baseRows: base.readRows,
          protectedRows: protectedResult.readRows,
          readRatio: Number((protectedResult.readRows / base.readRows).toFixed(2)),
          baseMs: Number(base.elapsedMs.toFixed(1)),
          protectedMs: Number(protectedResult.elapsedMs.toFixed(1)),
        }),
    );
  }, 120_000);

  it('plans one workspace-keyed exclusion set and a base-driven side scan', async () => {
    const settings = await store.settingsFor(ERASED_WORKSPACE);
    const result = await store.client.query({
      query: `EXPLAIN SELECT count() FROM events_protected(ws={ws:UUID}) FINAL WHERE workspace_id = {ws:UUID} AND ${WINDOW}`,
      query_params: { ws: ERASED_WORKSPACE },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const plan = (await result.json<Record<string, string>>()).map((row) => Object.values(row).join('')).join('\n');
    // One set, built from this workspace's ledger rows through the table's ordering prefix.
    expect(plan).toMatch(/Capture\[Set\]|CreatingSets/);
    expect(plan).toContain(`workspace_id = '${ERASED_WORKSPACE}'`);
    // The backfill identity join is fed by runtime filters built from the base rows, so a narrow
    // query does not read the workspace's whole side table.
    expect(plan).toContain('BuildRuntimeFilter');
    expect(plan).toMatch(/table_name = 'events'[\s\S]{0,400}?RF\d+\(/);
    // No per-row ledger materialisation and no per-kind join in the plan.
    expect(plan).not.toContain('groupUniqArray');
    expect(plan).not.toContain('LEFT ANTI JOIN');
  }, 120_000);
});
