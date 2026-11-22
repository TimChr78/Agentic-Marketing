import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { reconcileRestoredErasureExclusions } from '../src/ops/restore-reconcile';

// The restore's final step (#1194). It must publish only what the ClickHouse point lost, record the
// confirmation on the jobs, and leave a completed job complete instead of reopening every
// historical sweep. These tests use a fake ClickHouse store: the SQL and batching are what matter.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('restore reconciliation of erasure exclusions (#1194)', () => {
  it('re-publishes only missing keys, then marks the jobs published without reopening complete ones', async () => {
    const d = await createDisposableDb('restore_reconcile');
    open.push(d);
    const completeErasure = 'era_00000000000000000000000000000a11';
    const unfinishedErasure = 'era_00000000000000000000000000000b22';
    const keys = [
      { erasureId: completeErasure, key: 'a'.repeat(64) },
      { erasureId: completeErasure, key: 'b'.repeat(64) },
      { erasureId: unfinishedErasure, key: 'c'.repeat(64) },
    ];
    for (const erasureId of [completeErasure, unfinishedErasure])
      await d.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'user_test', 'reconcile test', '{"profiles":1}')`,
        [d.workspace, erasureId],
      );
    for (const { erasureId, key } of keys)
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
        [d.workspace, key, erasureId],
      );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'complete', 3, true, true,
               7, now(), now(), now())`,
      [d.workspace, completeErasure],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'failed', 36, true, true)`,
      [d.workspace, unfinishedErasure],
    );

    // The ClickHouse point still holds one of the two complete erasure's keys; the rest were lost.
    const present = new Set<string>([keys[0]!.key]);
    const published: { key: string; generation: number; erasureId: string }[] = [];
    const visibilityCalls: string[][] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set(present);
      },
      async publishErasedSubjects(rows: readonly { key: string; generation: number; erasureId: string }[]) {
        for (const row of rows) {
          published.push({ key: row.key, generation: row.generation, erasureId: row.erasureId });
          present.add(row.key);
        }
      },
      async erasedSubjectsVisible(_workspaceId: string, wanted: readonly string[]) {
        visibilityCalls.push([...wanted]);
        return wanted.every((key) => present.has(key));
      },
    };

    // Three keys at two per FINAL read: more than one chunk, which is what broke at 10,000 keys
    // ("Field value too long") when the whole set travelled in one parameter (#1194 review).
    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: d.url.toString(),
      events,
      log: () => {},
      batchSize: 2,
    });
    expect(result).toMatchObject({ workspaces: 1, keys: 3, inserted: 2, batches: 1, jobs: 2 });
    expect(published).toHaveLength(2);
    expect(published.every((row) => row.generation === 1)).toBe(true);
    expect(published.map((row) => row.key).sort()).toEqual([keys[1]!.key, keys[2]!.key].sort());
    expect(visibilityCalls.map((chunk) => chunk.length)).toEqual([2, 1]);

    const jobs = await d.db.admin.query<{
      erasure_id: string;
      state: string;
      attempts: number;
      published_generation: string;
      published_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT erasure_id, state, attempts, published_generation, published_at, completed_at
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 ORDER BY erasure_id`,
      [d.workspace],
    );
    const byErasure = new Map(jobs.rows.map((row) => [row.erasure_id, row]));
    // A complete job is confirmed but not reopened: no new sweep, no reset attempts.
    expect(byErasure.get(completeErasure)).toMatchObject({
      state: 'complete',
      attempts: 3,
      published_generation: '1',
      published_at: expect.any(Date),
      completed_at: expect.any(Date),
    });
    // An unfinished job is queued for its remaining sweep, with the publication already recorded.
    expect(byErasure.get(unfinishedErasure)).toMatchObject({
      state: 'pending_external',
      attempts: 0,
      published_generation: '1',
      published_at: expect.any(Date),
    });
    // A restored ClickHouse point may carry rows from before a purge, so progress is reset.
    const generations = await d.db.admin.query<{ purged_generation: string }>(
      'SELECT purged_generation FROM erasure_generations WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(generations.rows[0]?.purged_generation).toBe('0');

    // Idempotent: everything is visible and every job is already published.
    const again = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {}, batchSize: 2 });
    expect(again).toMatchObject({ workspaces: 1, keys: 3, inserted: 0, batches: 0, jobs: 2 });
    expect(published).toHaveLength(2);
    expect(visibilityCalls.map((chunk) => chunk.length)).toEqual([2, 1, 2, 1]);
  }, 120_000);
});
