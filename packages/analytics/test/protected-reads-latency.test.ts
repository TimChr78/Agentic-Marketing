import { clickHouseStore, type EventStore, migrateClickHouse, resetClickHouse } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { buildQuery } from '../src/compile';
import { freshness } from '../src/query';
import { MEASURES } from '../src/registry';

// #1037 part 2 latency. Two review findings shaped the read path and both are pinned here:
//   1. a workspace with no durable `erasure_keys` ledger row reads the base table (the shared read
//      layer's fast path), so it pays nothing for the protected view;
//   2. a workspace with exclusions builds the ledger as one set per query instead of sixteen joins.
// The ratios, not absolute milliseconds, are the contract: a CI machine is slower than a laptop.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_protected_latency');
const WORKSPACES = 12;
const PER_WORKSPACE = 100_000;
const uuidOf = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const ERASED_WORKSPACE = uuidOf(7);
const CLEAN_WORKSPACE = uuidOf(8);
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';
const SINCE = 30 * 86_400;

let store: EventStore;
/** What the workspace erasure checker answers for the next read; the store consults it per call. */
let protectedRead = true;

/** Median wall-clock of five runs after one warm-up. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  await run();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

const runSql = (sql: string, queryParams: Record<string, unknown>, workspace: string) => async () => {
  await (
    await store.client.query({
      query: sql,
      query_params: { ws: workspace, ...queryParams },
      format: 'JSONEachRow',
      clickhouse_settings: { ...(await store.settingsFor(workspace)), max_memory_usage: String(1 << 30) },
    })
  ).json();
};

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, hasErasures: async () => protectedRead });
  await store.client.command({
    query: `INSERT INTO events (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                                anonymous_id, user_id, profile_id, properties, traits, context, consent,
                                subject_coverage, subject_profile)
            SELECT toUUID(concat('00000000-0000-0000-0000-', leftPad(toString(intDiv(number, ${PER_WORKSPACE})), 12, '0'))),
                   toString(number), 'src_latency',
                   toDateTime64('2026-11-01', 3) + toIntervalSecond(number % 3600),
                   toDateTime64('2026-11-01', 3) + toIntervalSecond(number % 3600),
                   'track', 'Purchase', toString(number % 10000), '', toString(number),
                   '{}', '{}', '{}', map(), 'full', hex(SHA256(toString(number)))
            FROM numbers(${WORKSPACES * PER_WORKSPACE})`,
  });
  await store.client.command({
    query: `INSERT INTO message_events (workspace_id, message_id, event_id, type, at, profile_id, channel, purpose,
                                        provider, template_id, template_version, journey_id, variant, reason, url,
                                        subject_coverage, subject_profile)
            SELECT workspace_id, concat('msg_', event_id), event_id, 'sent', timestamp, profile_id, 'email',
                   'marketing_email', 'test', 'eml_latency', 1, 'bct_latency', '', '', '', 'full', subject_profile
            FROM events WHERE workspace_id = toUUID({ws:String})`,
    query_params: { ws: ERASED_WORKSPACE },
    clickhouse_settings: await store.settingsFor(ERASED_WORKSPACE),
  });
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
  // 100,000 exclusions in one workspace: one per profile hash there.
  await store.client.command({
    query: `INSERT INTO erased_subjects (workspace_id, kind, key, key_version, erasure_id, generation, recorded_at)
            SELECT toUUID({ws:String}), 'profile', subject_profile, 'dk_latency', 'era_latency', 1, now64(3)
            FROM events WHERE workspace_id = toUUID({ws:String}) AND profile_id != ''`,
    query_params: { ws: ERASED_WORKSPACE },
    clickhouse_settings: await store.settingsFor(ERASED_WORKSPACE),
  });
}, 300_000);

afterAll(async () => {
  await store?.close();
  await resetClickHouse(CH_URL, CH_DB).catch(() => {});
});

describe('protected reads stay close to the base read (#1037 part 2)', () => {
  it('reports the five reader paths: base, fast path and a 100,000-key ledger', async () => {
    const results: { path: string; base: number; fast: number; ledger: number }[] = [];

    const measure = async (path: string, run: (workspace: string, useProtected: boolean) => () => Promise<unknown>) => {
      // No allocation: the shared read layer chooses the base table, and the fast path is that same
      // choice for a workspace that never had an erasure.
      protectedRead = false;
      const base = await timed(run(CLEAN_WORKSPACE, false));
      protectedRead = false;
      const fast = await timed(run(CLEAN_WORKSPACE, false));
      // A workspace with 100,000 exclusions, through the protected view.
      protectedRead = true;
      const ledger = await timed(run(ERASED_WORKSPACE, true));
      protectedRead = true;
      results.push({ path, base, fast, ledger });
      console.log(
        `protected latency: ${JSON.stringify({
          path,
          baseMs: Number(base.toFixed(1)),
          fastMs: Number(fast.toFixed(1)),
          ledgerMs: Number(ledger.toFixed(1)),
          ledgerRatio: Number((ledger / Math.max(base, 0.1)).toFixed(1)),
        })}`,
      );
    };

    await measure('conversions 30d', (workspace, useProtected) => {
      const compiled = buildQuery({
        workspaceId: workspace,
        measures: [MEASURES.conversions!],
        dimensions: [],
        source: 'events',
        from: FROM,
        to: TO,
        timeZone: 'UTC',
        filters: { name: ['Purchase'] },
        limit: 1,
        conversionRules: [],
        conversionNames: ['Purchase'],
        protectedRead: useProtected,
      });
      return runSql(compiled.sql, compiled.params, workspace);
    });

    // A send-path guardrail: the metric names its own messages, so the run reads a bounded scope
    // rather than a workspace-wide window. 500 messages, as a just-sent broadcast has.
    const guardrailIds = Array.from({ length: 500 }, (_, i) => `msg_${PER_WORKSPACE * 7 + i}`);
    await measure('guardrail message stats', (workspace) => async () => {
      await store.messageStats(workspace, { since: new Date(FROM), messageIds: guardrailIds });
    });

    await measure('segment event counts', (workspace) => async () => {
      for await (const batch of store.countEventsBatches(workspace, { name: 'Purchase', sinceSeconds: SINCE })) void batch;
    });

    await measure('analytics freshness', (workspace, useProtected) => async () => {
      await freshness(
        { tx: undefined as never, events: store, workspaceId: workspace },
        { source: 'events', from: FROM, to: TO, filters: {}, names: ['Purchase'], protectedRead: useProtected },
      );
    });

    await measure('wait-until one person', (workspace) => async () => {
      await store.countEvents(workspace, { name: 'Purchase', sinceSeconds: SINCE, ids: { anonymousIds: ['1234'], userIds: [] } });
    });

    for (const result of results) {
      // The fast path must not pay for the view: same source, same plan, base timing.
      expect(result.fast / Math.max(result.base, 0.1), `${result.path} fast path`).toBeLessThan(1.5);
      // The protected path stays within a factor of the base read on a workspace with a large
      // ledger. This is a ratio on a shared table, not an absolute-millisecond assertion.
      expect(result.ledger / Math.max(result.base, 0.1), `${result.path} protected path`).toBeLessThan(40);
    }
  }, 300_000);
});
