import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteExpiredIdempotencyKeyBatch,
  deleteExpiredIdempotencyKeys,
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  IDEMPOTENCY_CLEANUP_MAX_BATCHES,
  IDEMPOTENCY_CLEANUP_TIME_BUDGET_MS,
  IDEMPOTENCY_RETENTION_DAYS,
  runIdempotencyKeyCleanup,
} from '../src/idempotency';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #976: the scheduler deletes idempotency keys past their retention in bounded batches. The
// batches must remove only expired rows, must not remove a row a live transaction is touching (a
// replay in progress), must use the created_at index rather than scan the whole table, and must
// stop at a per-tick budget so a large backlog is drained over several ticks.

let d: DisposableDb;
let client: pg.PoolClient;

/** Age the row with PostgreSQL's clock, the clock the retention cutoffs use. */
async function seed(key: string, days: number, workspace = d.workspace) {
  await d.db.admin.query(
    `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response, created_at)
     VALUES ($1, $2, 'test.write', 'hash', '{"ok":true}', now() - make_interval(days => $3))`,
    [workspace, key, days],
  );
}

async function keys() {
  const { rows } = await d.db.admin.query<{ key: string }>('SELECT key FROM idempotency_keys ORDER BY key');
  return rows.map((row) => row.key);
}

describe.skipIf(!hasTestDatabase())('idempotency key cleanup (#976)', () => {
  beforeAll(async () => {
    d = await createDisposableDb('idem_cleanup');
    client = await d.db.admin.connect();
  });

  afterAll(async () => {
    client?.release();
    await d?.close();
  });

  it('deletes expired rows only, in batches, and keeps the rest', async () => {
    for (let i = 0; i < 5; i++) await seed(`expired-${i}`, 31);
    await seed('fresh', 1);
    await seed('edge-29-days', 29);

    const result = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 2 });

    expect(result).toEqual({ batches: 3, deleted: 5, more: false });
    expect(await keys()).toEqual(['edge-29-days', 'fresh']);
  });

  it('leaves a row a live transaction is touching (a replay in progress)', async () => {
    await d.db.admin.query('DELETE FROM idempotency_keys');
    for (const key of ['busy', 'expired-a', 'expired-b']) await seed(key, 31);

    // The other session holds the row, as a request that has not finished would.
    await client.query('BEGIN');
    await client.query("SELECT * FROM idempotency_keys WHERE key = 'busy' FOR UPDATE");

    try {
      const first = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 10 });
      expect(first.deleted).toBe(2);
      expect(await keys()).toEqual(['busy']);

      // Once the live transaction ends, the next pass removes the row.
      await client.query('COMMIT');
      const second = await deleteExpiredIdempotencyKeyBatch(d.db.admin, { batchSize: 10 });
      expect(second).toBe(1);
      expect(await keys()).toEqual([]);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  });

  it('removes an expired row even when it is the only row, at the default batch size', async () => {
    await seed('single-expired', IDEMPOTENCY_RETENTION_DAYS + 1);
    expect(await deleteExpiredIdempotencyKeyBatch(d.db.admin)).toBe(1);
    expect(IDEMPOTENCY_CLEANUP_BATCH_SIZE).toBe(5_000);
    // A tick is bounded: at most 20 batches or 30 seconds, then the next tick continues.
    expect(IDEMPOTENCY_CLEANUP_MAX_BATCHES).toBe(20);
    expect(IDEMPOTENCY_CLEANUP_TIME_BUDGET_MS).toBe(30_000);
  });

  it('stops at its batch budget and drains the backlog on the next tick', async () => {
    await d.db.admin.query('DELETE FROM idempotency_keys');
    for (let i = 0; i < 5; i++) await seed(`backlog-${i}`, 31);

    const first = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 2, maxBatches: 2 });
    expect(first).toEqual({ batches: 2, deleted: 4, more: true });
    expect(await keys()).toEqual(['backlog-4']);

    const second = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 2, maxBatches: 2 });
    expect(second).toEqual({ batches: 1, deleted: 1, more: false });
    expect(await keys()).toEqual([]);
  });

  it('stops when its time budget is spent and continues on the next tick', async () => {
    await d.db.admin.query('DELETE FROM idempotency_keys');
    for (let i = 0; i < 4; i++) await seed(`timebudget-${i}`, 31);

    const first = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 2, timeBudgetMs: 0 });
    expect(first).toEqual({ batches: 1, deleted: 2, more: true });

    const second = await deleteExpiredIdempotencyKeys(d.db.admin, { batchSize: 2 });
    expect(second).toEqual({ batches: 1, deleted: 2, more: false });
    expect(await keys()).toEqual([]);
  });

  it('sweeps at start and again on its interval, until the signal aborts', async () => {
    await d.db.admin.query('DELETE FROM idempotency_keys');
    await seed('periodic', 31);
    const stop = new AbortController();
    const done = runIdempotencyKeyCleanup({ db: d.db }, stop.signal, { tickMs: 20 });
    try {
      const deadline = Date.now() + 5_000;
      while ((await keys()).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await keys()).toEqual([]);
    } finally {
      stop.abort();
      await done;
    }
  });

  it('uses the created_at index, touches only one batch, and the replay filter is an index scan', async () => {
    await d.db.admin.query('DELETE FROM idempotency_keys');
    // A realistic table: most rows expired, a recent minority. Normal planner settings, no
    // enable_seqscan override, so the plan is the one an install would get.
    await d.db.admin.query(
      `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response, created_at)
         SELECT $1, 'bulk-' || g, 'test.write', 'hash', '{"ok":true}'::jsonb, now() - make_interval(days => 31)
           FROM generate_series(1, 50000) AS g`,
      [d.workspace],
    );
    await d.db.admin.query(
      `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response, created_at)
         SELECT $1, 'recent-' || g, 'test.write', 'hash', '{"ok":true}'::jsonb, now() - make_interval(days => 1)
           FROM generate_series(1, 5000) AS g`,
      [d.workspace],
    );
    await d.db.admin.query('ANALYZE idempotency_keys');

    const plan = async (sql: string, values: unknown[]) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, values);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    };

    const cleanup = await plan(
      `DELETE FROM idempotency_keys
        WHERE ctid = ANY (ARRAY(
                SELECT ctid
                  FROM idempotency_keys
                 WHERE created_at < now() - make_interval(days => $1)
                 ORDER BY created_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
              ))`,
      [IDEMPOTENCY_RETENTION_DAYS, 100],
    );
    expect(cleanup).toContain('idempotency_keys_created_at');
    expect(cleanup).toContain('Limit');

    const before = await d.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_keys');
    expect(await deleteExpiredIdempotencyKeyBatch(d.db.admin, { batchSize: 100 })).toBe(100);
    const after = await d.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_keys');
    expect(before.rows[0]!.n - after.rows[0]!.n).toBe(100);

    const lookup = await plan(
      `SELECT response FROM idempotency_keys
        WHERE workspace_id = $1 AND key = $2
          AND created_at > now() - make_interval(days => $3)`,
      [d.workspace, 'recent-1', IDEMPOTENCY_RETENTION_DAYS],
    );
    // The composite index covers the predicate too (equality on workspace/key, range on
    // created_at); on a larger table the planner may instead take the primary key. Either is an
    // index scan, never a scan of the whole table.
    expect(lookup).toMatch(/Index Scan using idempotency_keys_(created_at|pkey)/);

    const index = await d.db.admin.query<{ valid: boolean; definition: string }>(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idempotency_keys_created_at'`,
    );
    expect(index.rows[0]?.valid).toBe(true);
    expect(index.rows[0]?.definition).toContain('created_at, workspace_id, key');
  });
});
