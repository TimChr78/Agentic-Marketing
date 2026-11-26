import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { erasureLedgerChecker } from '../src/erasureCleanup';
import { readErasureLog, replayErasures, replayErasuresAfterMigrate } from '../src/erasures';
import { RESTORE_APPLICATION_NAME } from '../src/pool';
import { createDisposableDb, hasTestDatabase } from './disposable';

// A restore from a snapshot taken before an erasure brings the person back (#144). The SQL log
// replay removes them again; #978 part 2b also recreates the durable external cleanup, because the
// restored ClickHouse and hot-state snapshot may still hold them. The selectors keep their sealing,
// so nothing is decrypted during the replay.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('restore recreates erasure cleanup jobs (#978 part 2b)', () => {
  it('carries a pending job and its sealed selectors into the restored database', async () => {
    const live = await createDisposableDb('erasure_jobs_live');
    const restored = await createDisposableDb('erasure_jobs_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000c0de';
    const erasureId = 'era_0000000000000000000000000000c0de';
    const selectors = Buffer.from('sealed selectors for the restore test');
    const selectorKey = Buffer.from('wrapped service key for the restore test');
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'restore test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
       VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, 'local-test')`,
      [live.workspace, erasureId, profile, selectors, selectorKey],
    );

    const log = await readErasureLog(live.url.toString());
    expect(log.cleanupJobs).toHaveLength(1);
    expect(log.cleanupJobs?.[0]).toMatchObject({ workspaceId: live.workspace, erasureId, profileIds: [profile] });
    expect(log.cleanupJobs?.[0]?.selectors).toEqual(selectors);

    // The restored snapshot is older than the erasure: same workspace, the person is back.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await restored.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      live.workspace,
      profile,
      'user_id',
      'restored-user',
    ]);

    // The snapshot also brings back the person's journey event markers, and their event ids are
    // caller-supplied (they can name the person), so the replay must remove them with the rows.
    await restored.db.admin.query(
      `INSERT INTO journey_processed_events (workspace_id, profile_id, event_id)
       VALUES ($1, $2, 'customer@example.test:purchase-1')`,
      [live.workspace, profile],
    );
    // A holdout arm is a person-keyed row a report reads; the restored snapshot brings it back
    // with the profile, so the replay must remove it (#1048).
    await restored.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       VALUES ($1, 'campaign', 'cmp_restore', 'hv_restore', $2, 'control')`,
      [live.workspace, profile],
    );

    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ erasures: 1, profiles: 1, cleanupJobs: 1 });

    const left = await restored.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [live.workspace, profile]);
    expect(left.rowCount).toBe(0);
    const markers = await restored.db.admin.query('SELECT 1 FROM journey_processed_events WHERE workspace_id = $1', [live.workspace]);
    expect(markers.rowCount).toBe(0);
    const holdouts = await restored.db.admin.query('SELECT 1 FROM holdout_assignments WHERE workspace_id = $1', [live.workspace]);
    expect(holdouts.rowCount).toBe(0);
    const jobs = await restored.db.admin.query<{
      state: string;
      next_attempt_at: Date;
      selectors: Buffer | null;
      selector_key: Buffer | null;
      selector_kek: string | null;
    }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [live.workspace, erasureId]);
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0]).toMatchObject({ state: 'pending_external', selectors, selector_key: selectorKey, selector_kek: 'local-test' });
    // Due at once: the scheduler cleans the restored external stores without an operator step.
    expect(jobs.rows[0]!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  }, 120_000);

  it('does not backfill a job for an erasure recorded before durable cleanup', async () => {
    const live = await createDisposableDb('erasure_jobs_nojob_live');
    const restored = await createDisposableDb('erasure_jobs_nojob_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000beef';
    const erasureId = 'era_0000000000000000000000000000beef';
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'legacy restore test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.cleanupJobs).toEqual([]);
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ erasures: 1, profiles: 1, cleanupJobs: 0 });
    const jobs = await restored.db.admin.query('SELECT 1 FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [
      live.workspace,
      erasureId,
    ]);
    expect(jobs.rowCount).toBe(0);
  }, 120_000);

  it("leaves a completed erasure's job alone, so a restore does not reopen historical sweeps", async () => {
    const live = await createDisposableDb('erasure_republish_live');
    const restored = await createDisposableDb('erasure_republish_restored');
    open.push(live, restored);
    const erasureIds: string[] = [];
    const keys: { erasureId: string; key: string }[] = [];
    // Many historical erasures that already finished: the restore's final reconciliation publishes
    // their keys in bulk and must not queue every one for another sweep (#1194 review, item 4).
    for (let i = 0; i < 25; i++) {
      const profile = `prf_${i.toString(16).padStart(32, '0')}`;
      const erasureId = `era_${i.toString(16).padStart(32, '0')}`;
      const key = i.toString(16).padStart(64, '0');
      erasureIds.push(erasureId);
      keys.push({ erasureId, key });
      await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
      await live.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'completed restore test', '{"profiles":1}')`,
        [live.workspace, erasureId, profile],
      );
      await live.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_republish', $3, 'full')`,
        [live.workspace, key, erasureId],
      );
      await live.db.admin.query(
        `INSERT INTO erasure_cleanup_jobs
           (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
            published_generation, published_at, coverage_cleared_at, completed_at)
         VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 3, true, true, 7, now(), now(), now())`,
        [live.workspace, erasureId, profile],
      );
    }
    const log = await readErasureLog(live.url.toString());
    expect(log.cleanupJobs).toHaveLength(25);
    expect(log.cleanupJobs?.every((job) => job.state === 'complete')).toBe(true);

    // The snapshot is the same database at a point that already held every completed job. Only
    // ClickHouse lost the publication, which is not part of the Postgres snapshot.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    for (const [index, erasureId] of erasureIds.entries()) {
      const profile = `prf_${index.toString(16).padStart(32, '0')}`;
      await restored.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'completed restore test', '{"profiles":1}')`,
        [live.workspace, erasureId, profile],
      );
      await restored.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_republish', $3, 'full')`,
        [live.workspace, keys[index]!.key, erasureId],
      );
      await restored.db.admin.query(
        `INSERT INTO erasure_cleanup_jobs
           (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
            published_generation, published_at, coverage_cleared_at, completed_at)
         VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 3, true, true, 7, now(), now(), now())`,
        [live.workspace, erasureId, profile],
      );
    }

    const replayed = await replayErasures(restored.url.toString(), log);
    // Nothing was re-queued: the restore reconciles the ledger in bulk, not by reopening every job.
    expect(replayed).toMatchObject({ erasures: 25, cleanupJobs: 0 });
    const jobs = await restored.db.admin.query<{
      state: string;
      attempts: number;
      published_generation: number | null;
      published_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT state, attempts, published_generation, published_at, completed_at
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 ORDER BY erasure_id`,
      [live.workspace],
    );
    expect(jobs.rowCount).toBe(25);
    for (const job of jobs.rows)
      expect(job).toMatchObject({
        state: 'complete',
        attempts: 3,
        published_generation: '7',
        published_at: expect.any(Date),
        completed_at: expect.any(Date),
      });

    // The restored ledger is what makes the read layer take the protected path for this workspace.
    expect(await erasureLedgerChecker(restored.db)(live.workspace)).toBe(true);

    // A second replay changes nothing either.
    expect(await replayErasures(restored.url.toString(), log)).toMatchObject({ cleanupJobs: 0 });
    const again = await restored.db.admin.query<{ state: string }>('SELECT state FROM erasure_cleanup_jobs WHERE workspace_id = $1', [
      live.workspace,
    ]);
    expect(again.rows.every((job) => job.state === 'complete')).toBe(true);
  }, 120_000);

  it('recreates a completed job as complete when the snapshot predates the job row (#1194 review)', async () => {
    const live = await createDisposableDb('erasure_predates_live');
    const restored = await createDisposableDb('erasure_predates_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000beef';
    const erasureId = 'era_0000000000000000000000000000beef';
    const key = 'a'.repeat(64);
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'predates snapshot', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_predates', $3, 'full')`,
      [live.workspace, key, erasureId],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 3, true, true, 7, now(), now(), now())`,
      [live.workspace, erasureId, profile],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.cleanupJobs).toMatchObject([{ state: 'complete' }]);

    // The snapshot is older than the job row: it carries the erasure and its ledger (both written
    // in the erasure's transaction) but no cleanup job. Replaying the live job must not queue a
    // sweep for work that already finished; reconciliation confirms the ledger keys in bulk.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'predates snapshot', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await restored.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_predates', $3, 'full')`,
      [live.workspace, key, erasureId],
    );

    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ erasures: 1, cleanupJobs: 0, completedJobs: 1 });
    const { rows } = await restored.db.admin.query<{
      state: string;
      attempts: number;
      next_attempt_at: Date;
      completed_at: Date | null;
      published_at: Date | null;
    }>(
      `SELECT state, attempts, next_attempt_at, completed_at, published_at
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2`,
      [live.workspace, erasureId],
    );
    expect(rows[0]).toMatchObject({ state: 'complete', attempts: 0, completed_at: expect.any(Date), published_at: null });
    // Reconciliation later marks it published; the replay itself added no sweep.
    expect(rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 1000);
  }, 120_000);

  it('reopens a job the snapshot still carried as unfinished, so its remaining sweep runs', async () => {
    const live = await createDisposableDb('erasure_unfinished_live');
    const restored = await createDisposableDb('erasure_unfinished_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000feed';
    const erasureId = 'era_0000000000000000000000000000feed';
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'unfinished restore test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_republish', $3, 'full')`,
      [live.workspace, 'f'.repeat(64), erasureId],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, published_generation)
       VALUES ($1, $2, ARRAY[$3]::text[], 'failed', 36, true, 4)`,
      [live.workspace, erasureId, profile],
    );
    const log = await readErasureLog(live.url.toString());

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'unfinished restore test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await restored.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, published_generation)
       VALUES ($1, $2, ARRAY[$3]::text[], 'failed', 36, true, 4)`,
      [live.workspace, erasureId, profile],
    );

    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed.cleanupJobs).toBe(1);
    const { rows } = await restored.db.admin.query<{
      state: string;
      attempts: number;
      next_attempt_at: Date;
      clickhouse_done: boolean;
      published_generation: number | null;
      published_at: Date | null;
    }>(
      `SELECT state, attempts, next_attempt_at, clickhouse_done, published_generation, published_at
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2`,
      [live.workspace, erasureId],
    );
    expect(rows[0]).toMatchObject({
      state: 'pending_external',
      attempts: 0,
      clickhouse_done: false,
      published_generation: null,
      published_at: null,
    });
    expect(rows[0]!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  }, 120_000);

  it('counts a live completed job it re-opens because the snapshot was unfinished as queued, not complete (#1223)', async () => {
    const live = await createDisposableDb('erasure_live_complete_l');
    const restored = await createDisposableDb('erasure_live_complete_r');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000ab23';
    const erasureId = 'era_0000000000000000000000000000ab23';
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'live complete, snapshot unfinished', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_live_complete', $3, 'full')`,
      [live.workspace, 'e'.repeat(64), erasureId],
    );
    // The live job finished after the backup was taken, so the snapshot still carries it running.
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 4, true, true, 8, now(), now(), now())`,
      [live.workspace, erasureId, profile],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.cleanupJobs).toMatchObject([{ state: 'complete' }]);

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'live complete, snapshot unfinished', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await restored.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation)
       VALUES ($1, $2, ARRAY[$3]::text[], 'running', 2, false, false, 2)`,
      [live.workspace, erasureId, profile],
    );

    const replayed = await replayErasures(restored.url.toString(), log);
    // The upsert re-opened the snapshot's unfinished row, so the job is queued for a sweep and must
    // not be reported as restored without one.
    expect(replayed).toMatchObject({ cleanupJobs: 1, completedJobs: 0 });
    const { rows } = await restored.db.admin.query<{ state: string; attempts: number; published_at: Date | null }>(
      `SELECT state, attempts, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2`,
      [live.workspace, erasureId],
    );
    expect(rows[0]).toMatchObject({ state: 'pending_external', attempts: 0, published_at: null });
  }, 120_000);

  it('migrates a pre-0108 snapshot before replaying, so the restored cleanup jobs exist', async () => {
    const live = await createDisposableDb('erasure_jobs_pre0108_live');
    // A snapshot taken before durable cleanup: its schema stops at 0107 and has no job table.
    const restored = await createDisposableDb('erasure_jobs_pre0108_restored', { upTo: '0107_broadcast_defer_count.sql' });
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000d00d';
    const erasureId = 'era_0000000000000000000000000000d00d';
    const selectors = Buffer.from('sealed selectors in a pre-0108 snapshot');
    const selectorKey = Buffer.from('wrapped service key in a pre-0108 snapshot');
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'pre-0108 restore test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
       VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, 'local-test')`,
      [live.workspace, erasureId, profile, selectors, selectorKey],
    );
    const log = await readErasureLog(live.url.toString());

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    // The table does not exist before the restore path migrates.
    const before = await restored.db.admin.query("SELECT to_regclass('public.erasure_cleanup_jobs') AS table");
    expect(before.rows[0]?.table).toBeNull();

    const replayed = await replayErasuresAfterMigrate(restored.url.toString(), log, {
      appRole: 'am_ops_test_app',
      appRolePassword: 'am_ops_test_password',
    });
    expect(replayed).toMatchObject({ erasures: 1, profiles: 1, cleanupJobs: 1 });
    const jobs = await restored.db.admin.query<{
      state: string;
      selectors: Buffer | null;
      selector_key: Buffer | null;
    }>('SELECT state, selectors, selector_key FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [
      live.workspace,
      erasureId,
    ]);
    expect(jobs.rows[0]).toMatchObject({ state: 'pending_external', selectors, selector_key: selectorKey });
  }, 120_000);

  it('reads every workspace’s erasures and keys as a non-BYPASSRLS table owner (#1204 review)', async () => {
    const live = await createDisposableDb('erasure_log_owner');
    open.push(live);
    const profile = 'prf_0000000000000000000000000000e0e0';
    const erasureId = 'era_0000000000000000000000000000e0e0';
    const key = 'a'.repeat(64);
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'owner log test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_tombstones (workspace_id, ident_hash, erased_at, erasure_id)
       VALUES ($1, $2, now(), $3)`,
      [live.workspace, 'b'.repeat(64), erasureId],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_owner', $3, 'full')`,
      [live.workspace, key, erasureId],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 1, true, true, 4, now(), now(), now())`,
      [live.workspace, erasureId, profile],
    );

    // A small install runs `am restore` as the owner of every table, which is subject to FORCE RLS.
    // Without a workspace set, that role reads zero of each table and the restore would replay
    // nothing (#1204 review).
    const suffix = randomBytes(4).toString('hex');
    const role = `am_restore_log_owner_${suffix}`;
    await live.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    const owned = [
      'data_keys',
      'erasure_cleanup_jobs',
      'erasure_generations',
      'erasure_keys',
      'erasure_tombstones',
      'erasures',
      'warehouse_erasure_key_tracking',
      'warehouse_erasure_keys',
    ];
    for (const table of owned) await live.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
    const forcedBefore = await live.db.admin.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
      [owned],
    );
    const limited = new URL(live.url.toString());
    limited.username = role;
    limited.password = 'rls-password';

    // Prove the premise: the owner sees nothing without `app.workspace_id`.
    const asOwner = new pg.Client({ connectionString: limited.toString() });
    await asOwner.connect();
    try {
      for (const table of ['erasures', 'erasure_keys', 'erasure_cleanup_jobs']) {
        const { rows } = await asOwner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0]?.n).toBe(0);
      }
    } finally {
      await asOwner.end();
    }

    const log = await readErasureLog(limited.toString());
    expect(log.erasures).toHaveLength(1);
    expect(log.erasures[0]).toMatchObject({ workspaceId: live.workspace, id: erasureId });
    expect(log.keys).toHaveLength(1);
    expect(log.keys?.[0]).toMatchObject({ workspaceId: live.workspace, erasureId, keyValue: key });
    expect(log.cleanupJobs).toHaveLength(1);
    expect(log.cleanupJobs?.[0]).toMatchObject({ workspaceId: live.workspace, erasureId, state: 'complete' });
    expect(log.tombstones).toHaveLength(1);

    // The FORCE lift was transactional: every table's FORCE flag is exactly as it was before.
    const forced = await live.db.admin.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
      [owned],
    );
    expect(forced.rows.filter((row) => row.forced).length).toBeGreaterThan(0);
    expect(forced.rows).toEqual(forcedBefore.rows);
  }, 120_000);

  it('replays the whole log as a non-BYPASSRLS table owner (#1204 review)', async () => {
    const live = await createDisposableDb('erasure_owner_replay_live');
    const restored = await createDisposableDb('erasure_owner_replay_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000aa11';
    const erasureId = 'era_0000000000000000000000000000aa11';
    const key = 'c'.repeat(64);
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'owner replay test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_owner', $3, 'full')`,
      [live.workspace, key, erasureId],
    );
    // The restored snapshot predates the erasure: the person and an identifier are back.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await restored.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      live.workspace,
      profile,
      'user_id',
      'owner-replay-user',
    ]);

    // Every table belongs to the small install's own role, which FORCE RLS applies to as well.
    const role = `am_restore_owner_replay_${randomBytes(4).toString('hex')}`;
    await live.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    for (const db of [live, restored]) {
      const { rows } = await db.db.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      for (const { tablename } of rows) await db.db.admin.query(`ALTER TABLE "${tablename}" OWNER TO "${role}"`);
    }
    const urlFor = (db: typeof live) => {
      const url = new URL(db.url.toString());
      url.username = role;
      url.password = 'rls-password';
      return url.toString();
    };

    // The workspace list, the erasures and the keys all have to be read for the replay to work: the
    // owner sees none of them without a workspace set, and a skipped entry resurrects the person.
    const log = await readErasureLog(urlFor(live));
    expect(log.erasures).toHaveLength(1);
    expect(log.keys).toHaveLength(1);
    const replayed = await replayErasures(urlFor(restored), log);
    expect(replayed).toMatchObject({ workspaces: 1, erasures: 1, profiles: 1, keys: 1, skipped: 0 });
    const left = await restored.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [live.workspace, profile]);
    expect(left.rowCount).toBe(0);
  }, 120_000);

  it('refuses the log when the role can neither own nor bypass its row-level security (#1204 review)', async () => {
    const live = await createDisposableDb('erasure_log_reader');
    open.push(live);
    const erasureId = 'era_0000000000000000000000000000f0f0';
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_0000000000000000000000000000f0f0']::text[], 'user_test', 'reader log test', '{"profiles":1}')`,
      [live.workspace, erasureId],
    );
    const role = `am_restore_log_reader_${randomBytes(4).toString('hex')}`;
    await live.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    // Reading is allowed; row-level security still hides every row from a role that is not the
    // owner. Returning an empty log would let the restore drop the erasures without a word.
    await live.db.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    const limited = new URL(live.url.toString());
    limited.username = role;
    limited.password = 'rls-password';
    await expect(readErasureLog(limited.toString())).rejects.toThrow(/hidden by row-level security from role/);
  }, 120_000);

  it('replays nothing when its abort signal already fired (#1204 review)', async () => {
    const live = await createDisposableDb('erasure_abort_live');
    const restored = await createDisposableDb('erasure_abort_restored');
    open.push(live, restored);
    const profile = 'prf_0000000000000000000000000000ab0a';
    const erasureId = 'era_0000000000000000000000000000ab0a';
    await live.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);
    await live.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'abort test', '{"profiles":1}')`,
      [live.workspace, erasureId, profile],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.erasures).toHaveLength(1);
    // The restored snapshot still holds the person, so a replay would erase them.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [live.workspace]);
    await restored.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [live.workspace, profile]);

    const abort = new AbortController();
    abort.abort(new Error('the restore lock was lost'));
    await expect(
      replayErasuresAfterMigrate(restored.url.toString(), log, {
        appRolePassword: 'not-used',
        applicationName: RESTORE_APPLICATION_NAME,
        signal: abort.signal,
      }),
    ).rejects.toThrow(/restore lock was lost/);
    // Nothing ran: the lock is already gone, so even the migration and the first write were refused.
    const profiles = await restored.db.admin.query('SELECT id FROM profiles WHERE workspace_id = $1 AND id = $2', [
      live.workspace,
      profile,
    ]);
    expect(profiles.rows).toHaveLength(1);
    const erasures = await restored.db.admin.query('SELECT id FROM erasures WHERE workspace_id = $1', [live.workspace]);
    expect(erasures.rows).toEqual([]);
    const jobs = await restored.db.admin.query('SELECT erasure_id FROM erasure_cleanup_jobs WHERE workspace_id = $1', [live.workspace]);
    expect(jobs.rows).toEqual([]);
  }, 120_000);
});
