import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRestoreFence,
  RESTORE_ADVISORY_LOCK_KEY,
  type RestoreFenceState,
  raiseRestoreFence,
  restoreFenceState,
} from '@agentic-marketing/db';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { runningRestoreChildren, runRestoreChild, stopRestoreChildren } from '../src/ops/backup-lib';
import { acquireRestoreSessionLock, finishRestoreReconciliation, reconcileRestoredErasureExclusions } from '../src/ops/restore-reconcile';

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

  it('cleans a completed job’s outbox rows before confirming it complete (#1194 review)', async () => {
    const d = await createDisposableDb('restore_outbox');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000c33';
    const erasedProfile = 'prf_00000000000000000000000000000002';
    const otherProfile = 'prf_00000000000000000000000000000003';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'restore outbox test', '{"profiles":1}')`,
      [d.workspace, erasureId, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
      [d.workspace, 'd'.repeat(64), erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 2, true, true, 4, now(), now(), now())`,
      [d.workspace, erasureId, erasedProfile],
    );
    // The pre-erasure snapshot can carry rows queued before the erasure. The failed ones are what
    // the worker's own final pass would drop; the pending one would otherwise be published by the
    // started app after the restore.
    const outbox = [
      { id: 'ob_segment_failed', kind: 'segment_change', state: 'failed', profile: erasedProfile, batch: true },
      { id: 'ob_message_failed', kind: 'message_event', state: 'failed', profile: erasedProfile, batch: true },
      { id: 'ob_message_pending', kind: 'message_event', state: 'pending', profile: erasedProfile, batch: true },
      { id: 'ob_other_failed', kind: 'message_event', state: 'failed', profile: otherProfile, batch: true },
    ];
    for (const row of outbox)
      await d.db.admin.query(
        `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
         VALUES ($1, $2, $3, $4::jsonb, $2, $5, 3)`,
        [
          d.workspace,
          row.id,
          row.kind,
          JSON.stringify({
            events: [{ workspaceId: d.workspace, properties: { profile_id: row.profile }, profileId: row.profile }],
          }),
          row.state,
        ],
      );

    const published: string[] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set<string>();
      },
      async publishErasedSubjects(rows: readonly { key: string }[]) {
        for (const row of rows) published.push(row.key);
      },
      async erasedSubjectsVisible() {
        return true;
      },
    };
    const result = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {} });
    expect(result).toMatchObject({ workspaces: 1, inserted: 1, jobs: 1, outboxRows: 3, outboxDeferred: 0 });
    expect(published).toEqual(['d'.repeat(64)]);

    const left = await d.db.admin.query<{ id: string }>(`SELECT id FROM outbox WHERE workspace_id = $1`, [d.workspace]);
    expect(left.rows.map((row) => row.id)).toEqual(['ob_other_failed']);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete' });
    expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
  }, 120_000);

  it('publishes each workspace’s restored ledger only into that workspace (#1204 review)', async () => {
    const d = await createDisposableDb('restore_reconcile_multi');
    open.push(d);
    // A second tenant: RLS would separate these rows for the app, but a restore commonly runs as a
    // superuser or a BYPASSRLS role, which sees both workspaces in one query. Every publication
    // row must still name the workspace whose ledger it came from.
    const other = randomUUID();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other restore', 'none')", [other]);
    const fixtures = [
      {
        workspace: d.workspace,
        erasureId: 'era_00000000000000000000000000000e55',
        key: 'f'.repeat(64),
        profile: 'prf_00000000000000000000000000000005',
      },
      {
        workspace: other,
        erasureId: 'era_00000000000000000000000000000e66',
        key: '1'.repeat(64),
        profile: 'prf_00000000000000000000000000000006',
      },
    ];
    for (const fixture of fixtures) {
      await d.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'multi-workspace reconcile test', '{"profiles":1}')`,
        [fixture.workspace, fixture.erasureId, fixture.profile],
      );
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
        [fixture.workspace, fixture.key, fixture.erasureId],
      );
      await d.db.admin.query(
        `INSERT INTO erasure_cleanup_jobs
           (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
            published_generation, published_at, coverage_cleared_at, completed_at)
         VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
        [fixture.workspace, fixture.erasureId, fixture.profile],
      );
    }

    // ClickHouse state is per workspace: a key published under the wrong workspace would never hide
    // that person's reads, and would leak the key into a tenant it does not belong to.
    const present = new Map<string, Set<string>>();
    const published: { workspaceId: string; key: string }[] = [];
    const events = {
      async erasedSubjectKeys(workspaceId: string) {
        return new Set(present.get(workspaceId) ?? []);
      },
      async publishErasedSubjects(rows: readonly { workspaceId: string; key: string }[]) {
        for (const row of rows) {
          published.push({ workspaceId: row.workspaceId, key: row.key });
          const keys = present.get(row.workspaceId) ?? new Set<string>();
          keys.add(row.key);
          present.set(row.workspaceId, keys);
        }
      },
      async erasedSubjectsVisible(workspaceId: string, wanted: readonly string[]) {
        const keys = present.get(workspaceId) ?? new Set<string>();
        return wanted.every((key) => keys.has(key));
      },
    };

    const result = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {} });
    expect(result).toMatchObject({ workspaces: 2, keys: 2, inserted: 2, jobs: 2 });
    const byWorkspace = (a: { workspaceId: string }, b: { workspaceId: string }) => (a.workspaceId < b.workspaceId ? -1 : 1);
    expect(published.sort(byWorkspace)).toEqual(fixtures.map(({ workspace, key }) => ({ workspaceId: workspace, key })).sort(byWorkspace));
  }, 120_000);

  it('cleans a completed job’s outbox rows even when it has no publishable keys (#1204 review)', async () => {
    const d = await createDisposableDb('restore_outbox_nokeys');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000f77';
    const erasedProfile = 'prf_00000000000000000000000000000007';
    const otherProfile = 'prf_00000000000000000000000000000008';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'restore keyless outbox test', '{"profiles":1}')`,
      [d.workspace, erasureId, erasedProfile],
    );
    // A job that completed before the durable ledger (or on a generation-0 publication) has no
    // publishable key at all. Its final outbox pass still has to happen after a restore.
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 4, true, true, 0, NULL, now())`,
      [d.workspace, erasureId, erasedProfile],
    );
    const outbox = [
      { id: 'ob_keyless_failed', state: 'failed', profile: erasedProfile },
      { id: 'ob_keyless_pending', state: 'pending', profile: erasedProfile },
      { id: 'ob_keyless_other', state: 'failed', profile: otherProfile },
    ];
    for (const row of outbox)
      await d.db.admin.query(
        `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
         VALUES ($1, $2, 'message_event', $3::jsonb, $2, $4, 3)`,
        [
          d.workspace,
          row.id,
          JSON.stringify({
            events: [{ workspaceId: d.workspace, properties: { profile_id: row.profile }, profileId: row.profile }],
          }),
          row.state,
        ],
      );

    const published: string[] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set<string>();
      },
      async publishErasedSubjects(rows: readonly { key: string }[]) {
        for (const row of rows) published.push(row.key);
      },
      async erasedSubjectsVisible() {
        return true;
      },
    };
    const result = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {} });
    // Nothing was publishable, so nothing is claimed as published, but the outbox is cleaned.
    expect(result).toMatchObject({ workspaces: 0, keys: 0, inserted: 0, jobs: 0, outboxRows: 2, outboxDeferred: 0 });
    expect(published).toEqual([]);
    const left = await d.db.admin.query<{ id: string }>('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
    expect(left.rows.map((row) => row.id)).toEqual(['ob_keyless_other']);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete', published_at: null });
  }, 120_000);

  it('reconciles a restored ledger row as a non-BYPASSRLS table owner (#1194 review)', async () => {
    const d = await createDisposableDb('restore_reconcile_rls');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000d44';
    const key = 'e'.repeat(64);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000004']::text[], 'user_test', 'restore rls test', '{"profiles":1}')`,
      [d.workspace, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
      [d.workspace, key, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000004']::text[], 'complete', 1, true, true,
               3, now(), now(), now())`,
      [d.workspace, erasureId],
    );

    // A small install runs the restore as the owner of the tables, which is subject to FORCE RLS.
    // The ledger is invisible to that role until each transaction names its workspace.
    const suffix = randomBytes(4).toString('hex');
    const role = `am_restore_owner_${suffix}`;
    await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    for (const table of ['erasure_keys', 'erasure_cleanup_jobs', 'erasure_generations', 'outbox'])
      await d.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
    const limited = new URL(d.url.toString());
    limited.username = role;
    limited.password = 'rls-password';

    // Prove the premise: the owner sees no ledger row without `app.workspace_id`.
    const asOwner = new pg.Client({ connectionString: limited.toString() });
    await asOwner.connect();
    try {
      const { rows } = await asOwner.query<{ n: number }>(`SELECT count(*)::int AS n FROM erasure_keys`);
      expect(rows[0]?.n).toBe(0);
    } finally {
      await asOwner.end();
    }

    const published: string[] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set<string>();
      },
      async publishErasedSubjects(rows: readonly { key: string }[]) {
        for (const row of rows) published.push(row.key);
      },
      async erasedSubjectsVisible() {
        return true;
      },
    };
    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: limited.toString(),
      events,
      log: () => {},
    });
    expect(result).toMatchObject({ workspaces: 1, keys: 1, inserted: 1, jobs: 1, outboxRows: 0 });
    expect(published).toEqual([key]);

    // FORCE is back after the enumeration transaction, and the job was confirmed.
    const forced = await d.db.admin.query<{ forced: boolean }>(
      `SELECT relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'erasure_keys'`,
    );
    expect(forced.rows[0]?.forced).toBe(true);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete' });
    expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
  }, 120_000);

  it('reports a lost exclusive restore lock and stops its children (#1204 review)', async () => {
    const d = await createDisposableDb('restore_session_lock_lost');
    open.push(d);
    const databaseUrl = d.url.toString();
    let lost = '';
    // A stand-in for `pg_restore`: a child that outlives the lock holder would keep writing into a
    // database another restore may already own. Its rejection is handled from the start, because
    // the lock loss can stop it before the assertion below runs.
    const child = runRestoreChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {}).then(
      () => 'exited' as const,
      () => 'killed' as const,
    );
    const session = await acquireRestoreSessionLock(databaseUrl, {
      onLost: (err) => {
        lost = err.message;
        void stopRestoreChildren();
      },
    });
    try {
      const found = Date.now() + 5_000;
      while (runningRestoreChildren() === 0 && Date.now() < found) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runningRestoreChildren()).toBe(1);
      // The backend that holds the session lock, found the way an operator would: by its lock. The
      // key is per database, and other servers on the same cluster hold it in theirs.
      const finder = new pg.Client({ connectionString: databaseUrl });
      await finder.connect();
      try {
        const { rows } = await finder.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND granted AND pid <> pg_backend_pid()
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [RESTORE_ADVISORY_LOCK_KEY],
        );
        expect(rows).toHaveLength(1);
        await finder.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      } finally {
        await finder.end();
      }
      await expect(child).resolves.toBe('killed');
      const deadline = Date.now() + 15_000;
      while (!lost && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lost).toMatch(/terminat|connection/i);
      expect(runningRestoreChildren()).toBe(0);
    } finally {
      await stopRestoreChildren();
      await session.release();
    }
  }, 120_000);

  it('stops a child that ignores SIGTERM before reporting the restore stopped (#1204 review)', async () => {
    // A `pg_restore` that ignores SIGTERM must still be gone before the process exits: the old
    // handler returned immediately after scheduling SIGKILL, so `process.exit` won the race and the
    // child outlived the interlock.
    const ready = join(tmpdir(), `am-restore-child-${randomUUID()}`);
    const child = runRestoreChild(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');` +
          "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);",
      ],
      {},
    ).then(
      () => 'exited' as const,
      () => 'killed' as const,
    );
    // The handler is installed only once Node has evaluated the script; SIGTERM before that uses the
    // default disposition and would not test the escalation.
    const installed = Date.now() + 5_000;
    while (!existsSync(ready) && Date.now() < installed) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(ready)).toBe(true);
    expect(runningRestoreChildren()).toBe(1);
    const started = Date.now();
    await stopRestoreChildren();
    // It had to be escalated, and the promise only resolved once the child was actually gone.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(runningRestoreChildren()).toBe(0);
    await expect(child).resolves.toBe('killed');
    await rm(ready, { force: true });
  }, 120_000);

  it('clears a fence only when it belongs to the attempt clearing it (#1204 review)', async () => {
    const d = await createDisposableDb('restore_fence_owner');
    open.push(d);
    const attemptOne = { backup: '/backups/attempt-one', startedAt: '2026-11-01T00:00:00.000Z' };
    const attemptTwo = { backup: '/backups/attempt-two', startedAt: '2026-11-02T00:00:00.000Z' };
    await raiseRestoreFence(d.db.admin, attemptTwo);

    // A late write from an attempt that no longer holds the lock must not remove the current fence.
    await clearRestoreFence(d.db.admin, attemptOne);
    expect(await restoreFenceState(d.db.admin)).toEqual(attemptTwo);

    // Its own row is still cleared.
    await clearRestoreFence(d.db.admin, attemptTwo);
    expect(await restoreFenceState(d.db.admin)).toBeNull();
  }, 120_000);

  it('leaves another attempt’s fence and does no further work after the lock is lost (#1204 review)', async () => {
    const d = await createDisposableDb('restore_fence_lost');
    open.push(d);
    const erasedProfile = 'prf_00000000000000000000000000000007';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_00000000000000000000000000000d77', ARRAY[$2]::text[], 'user_test', 'lost lock test', '{"profiles":1}')`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, 'era_00000000000000000000000000000d77', ARRAY[$2]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
       VALUES ($1, 'ob_lost_lock', 'message_event',
               jsonb_build_object('events', jsonb_build_array(jsonb_build_object('profileId', $2::text))),
               'ob_lost_lock', 'pending', 0)`,
      [d.workspace, erasedProfile],
    );
    // The reviewer's scenario: attempt #1 holds the lock and raised its fence, its backend is
    // terminated, attempt #2 takes the lock and raises its own fence, and #1 then reaches the end of
    // its run. Before the fix, #1's reconciliation cleared #2's fence through a separate connection.
    const databaseUrl = d.url.toString();
    const attemptOne: RestoreFenceState = { backup: '/backups/attempt-one', startedAt: '2026-11-01T00:00:00.000Z' };
    let lost: Error | null = null;
    const abort = new AbortController();
    const sessionOne = await acquireRestoreSessionLock(databaseUrl, {
      onLost: (err) => {
        lost = err;
        abort.abort(err);
      },
    });
    await raiseRestoreFence(sessionOne.client, attemptOne);
    const finder = new pg.Client({ connectionString: databaseUrl });
    await finder.connect();
    try {
      const { rows } = await finder.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND granted AND pid <> pg_backend_pid()
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [RESTORE_ADVISORY_LOCK_KEY],
      );
      expect(rows).toHaveLength(1);
      await finder.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
    } finally {
      await finder.end();
    }
    const lostBy = Date.now() + 15_000;
    while (!lost && Date.now() < lostBy) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).toBeInstanceOf(Error);

    // Attempt #2 may need a moment to see the ended backend's session lock released.
    let sessionTwo: Awaited<ReturnType<typeof acquireRestoreSessionLock>> | undefined;
    const freeBy = Date.now() + 15_000;
    while (!sessionTwo && Date.now() < freeBy) {
      sessionTwo = await acquireRestoreSessionLock(databaseUrl).catch(() => undefined);
      if (!sessionTwo) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sessionTwo).toBeDefined();
    const attemptTwo: RestoreFenceState = { backup: '/backups/attempt-two', startedAt: new Date().toISOString() };
    await raiseRestoreFence(sessionTwo!.client, attemptTwo);

    try {
      await expect(
        finishRestoreReconciliation({
          databaseUrl,
          events: {
            async erasedSubjectKeys() {
              throw new Error('ClickHouse must not be read after the restore lock was lost');
            },
            async publishErasedSubjects() {
              throw new Error('ClickHouse must not be written after the restore lock was lost');
            },
            async erasedSubjectsVisible() {
              throw new Error('ClickHouse must not be read after the restore lock was lost');
            },
          },
          log: () => {},
          signal: abort.signal,
          fence: attemptOne,
          fenceClient: sessionOne.client,
        }),
      ).rejects.toThrow(/terminat|connection|lost/i);
      expect(await restoreFenceState(d.db.admin)).toEqual(attemptTwo);
      // The completed job's outbox pass is a write too: it did not run after the loss.
      const outbox = await d.db.admin.query('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
      expect(outbox.rows.map((row) => row.id)).toEqual(['ob_lost_lock']);
    } finally {
      await sessionTwo!.release();
      await sessionOne.release();
    }
  }, 120_000);

  it('cleans a completed job’s outbox when the restored snapshot predates the erasure ledger (#1204 review)', async () => {
    const d = await createDisposableDb('restore_outbox_no_ledger');
    open.push(d);
    const erasedProfile = 'prf_00000000000000000000000000000008';
    // A snapshot at the 0110 schema: the cleanup job table exists, the durable ledger does not.
    await d.db.admin.query('DROP TABLE erasure_keys');
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_00000000000000000000000000000e88', ARRAY[$2]::text[], 'user_test', 'pre-ledger restore', '{"profiles":1}')`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, 'era_00000000000000000000000000000e88', ARRAY[$2]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
       VALUES ($1, 'ob_pre_ledger', 'message_event',
               jsonb_build_object('events', jsonb_build_array(jsonb_build_object('profileId', $2::text))),
               'ob_pre_ledger', 'pending', 0)`,
      [d.workspace, erasedProfile],
    );

    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: d.url.toString(),
      events: {
        async erasedSubjectKeys() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
        async publishErasedSubjects() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
        async erasedSubjectsVisible() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
      },
      log: () => {},
    });
    expect(result).toMatchObject({ workspaces: 0, keys: 0, inserted: 0, jobs: 0, outboxRows: 1 });
    const left = await d.db.admin.query('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
    expect(left.rows).toEqual([]);
  }, 120_000);
});
