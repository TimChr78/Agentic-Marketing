import { afterAll, describe, expect, it } from 'vitest';
import { readErasureLog, replayErasures, replayErasuresAfterMigrate } from '../src/erasures';
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

    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ erasures: 1, profiles: 1, cleanupJobs: 1 });

    const left = await restored.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [live.workspace, profile]);
    expect(left.rowCount).toBe(0);
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
  });

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
  });

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
  });
});
