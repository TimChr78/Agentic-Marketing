import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESTORE_ADVISORY_LOCK_KEY, raiseRestoreFence } from '@agentic-marketing/db';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import {
  backupHealth,
  createBackup,
  readScheduleStatus,
  restoreBackup,
  runScheduledBackups,
  type ScheduleStatus,
} from '../src/ops/backup-lib';
import { acquireBackupInterlock, acquireRestoreSessionLock } from '../src/ops/restore-reconcile';

// A restore that stops after the Postgres load and before its reconciliation leaves the fence in
// `public.restore_fence`: a database no server may serve. A backup taken at that point would look
// complete and verified, and restoring it later would clear the fence over a point whose erasure
// exclusions were never replayed. Both the manual command and the scheduled service must refuse.

const FENCE = { backup: '/backups/am-manual-interrupted', startedAt: '2026-11-23T20:00:00.000Z' };

/**
 * A `pg_dump` stand-in on PATH. It leaves a marker, so a test can prove that no dump was started,
 * and writes an archive-shaped file, so a test that expects a backup can still complete without the
 * client tools. The content plays no part in whether the fence is consulted.
 */
async function withDumpStandIn<T>(fn: (marker: string) => Promise<T>): Promise<T> {
  const bin = await mkdtemp(join(tmpdir(), 'am-fence-bin-'));
  const marker = join(bin, 'dump-started');
  const savedPath = process.env.PATH;
  const savedMarker = process.env.AM_TEST_PG_DUMP_MARKER;
  try {
    await writeFile(
      join(bin, 'pg_dump'),
      '#!/bin/sh\n' +
        'printf started > "$AM_TEST_PG_DUMP_MARKER"\n' +
        'out=""; prev=""\n' +
        'for a in "$@"; do\n' +
        '  if [ "$prev" = "--file" ]; then out="$a"; fi\n' +
        '  prev="$a"\n' +
        'done\n' +
        'printf "backup fence test stand-in" > "$out"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.AM_TEST_PG_DUMP_MARKER = marker;
    return await fn(marker);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedMarker === undefined) delete process.env.AM_TEST_PG_DUMP_MARKER;
    else process.env.AM_TEST_PG_DUMP_MARKER = savedMarker;
    await rm(bin, { recursive: true, force: true });
  }
}

/** Waits until the scheduler loop has recorded the result of a run: the timestamp is written with it. */
async function waitForSchedule(dir: string, done: (status: ScheduleStatus) => boolean): Promise<ScheduleStatus> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await readScheduleStatus(dir);
    if (status && done(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the scheduler did not record a completed run within 90s');
}

/** A `pg_dump` stand-in that stays in flight until the test has cut the backup's interlock. */
async function withHangingDumpStandIn<T>(fn: (marker: string) => Promise<T>): Promise<T> {
  const bin = await mkdtemp(join(tmpdir(), 'am-hanging-bin-'));
  const marker = join(bin, 'dump-started');
  const savedPath = process.env.PATH;
  const savedMarker = process.env.AM_TEST_PG_DUMP_MARKER;
  try {
    await writeFile(
      join(bin, 'pg_dump'),
      '#!/bin/sh\n' +
        'printf started > "$AM_TEST_PG_DUMP_MARKER"\n' +
        'sleep 10\n' +
        'out=""; prev=""\n' +
        'for a in "$@"; do\n' +
        '  if [ "$prev" = "--file" ]; then out="$a"; fi\n' +
        '  prev="$a"\n' +
        'done\n' +
        'printf "backup lock test stand-in" > "$out"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.AM_TEST_PG_DUMP_MARKER = marker;
    return await fn(marker);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedMarker === undefined) delete process.env.AM_TEST_PG_DUMP_MARKER;
    else process.env.AM_TEST_PG_DUMP_MARKER = savedMarker;
    await rm(bin, { recursive: true, force: true });
  }
}

/** Waits until a path exists, for a stand-in that reports that it started. */
async function waitForPath(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`${path} never appeared`);
}

/** Ends the backend that holds the backup's shared interlock, as a lost connection would. */
async function terminateBackupInterlock(databaseUrl: string): Promise<void> {
  const finder = new pg.Client({ connectionString: databaseUrl });
  await finder.connect();
  try {
    const { rows } = await finder.query<{ pid: number }>(
      `SELECT l.pid FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.objid = $1 AND l.objsubid = 1 AND l.granted AND l.mode = 'ShareLock'
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [RESTORE_ADVISORY_LOCK_KEY],
    );
    expect(rows).toHaveLength(1);
    await finder.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
  } finally {
    await finder.end();
  }
}

describe.skipIf(!hasTestDatabase())('backup refuses while the restore fence is raised', () => {
  it('refuses a manual backup before starting the dump, and takes it once the fence is gone', async () => {
    const d = await createDisposableDb('backup_fence_manual');
    const out = await mkdtemp(join(tmpdir(), 'am-fence-manual-'));
    try {
      await raiseRestoreFence(d.db.admin, FENCE);
      await withDumpStandIn(async (marker) => {
        const error = await createBackup({ dir: out, databaseUrl: d.url.toString(), env: process.env, log: () => {} }).catch(
          (err: Error) => err,
        );
        expect(error).toBeInstanceOf(Error);
        // The operator is told what state the database is in and both ways out.
        expect((error as Error).message).toMatch(/A restore of \/backups\/am-manual-interrupted started at .* has not finished/);
        expect((error as Error).message).toContain('am restore --clear-fence');
        // Nothing was written: no directory, no dump child.
        expect(await readdir(out)).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();
      });

      // The same call succeeds once the fence is gone: the refusal came from the fence, not the setup.
      await d.db.admin.query('DELETE FROM public.restore_fence');
      await withDumpStandIn(async (marker) => {
        const { dir } = await createBackup({ dir: out, databaseUrl: d.url.toString(), env: process.env, log: () => {} });
        expect(dir.split('/').pop()).toMatch(/^am-manual-/);
        expect((await readdir(out)).some((name) => name.startsWith('am-'))).toBe(true);
        expect((await stat(marker)).isFile()).toBe(true);
      });
    } finally {
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('records a failed scheduled run that --health reports, and writes no backup', async () => {
    const d = await createDisposableDb('backup_fence_scheduled');
    const dir = await mkdtemp(join(tmpdir(), 'am-fence-scheduled-'));
    const controller = new AbortController();
    try {
      await raiseRestoreFence(d.db.admin, FENCE);
      await withDumpStandIn(async (marker) => {
        const env = { ...process.env, DATABASE_URL: d.url.toString(), BACKUP_DIR: dir, BACKUP_CRON: '* * * * *' };
        const running = runScheduledBackups({ env, log: () => {}, signal: controller.signal });
        const status = await waitForSchedule(dir, (current) => current.lastOk === false);
        controller.abort();
        expect(await running).toBe(0);

        expect(status.lastOk).toBe(false);
        expect(status.lastError).toMatch(/restore .* has not finished/);
        expect((await readdir(dir)).filter((name) => name.startsWith('am-'))).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();

        // The container healthcheck reads the failed run, not just the heartbeat.
        const health = await backupHealth({ dir, env });
        expect(health.ok).toBe(false);
        expect(health.reason).toMatch(/last scheduled backup .* failed: .*am restore --clear-fence/);
      });
    } finally {
      controller.abort();
      await d.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a non-BYPASSRLS table owner under a fence, then for its role once the fence is gone', async () => {
    const d = await createDisposableDb('backup_fence_owner');
    const out = await mkdtemp(join(tmpdir(), 'am-fence-owner-'));
    const suffix = randomBytes(4).toString('hex');
    const role = `am_fence_owner_${suffix}`;
    const password = 'fence-owner-password';
    const owner = d.url.username;
    try {
      await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
      // The small-install shape: the migration role owns every table but does not bypass RLS.
      const tables = await d.db.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      for (const { tablename } of tables.rows) await d.db.admin.query(`ALTER TABLE "public"."${tablename}" OWNER TO ${role}`);
      await raiseRestoreFence(d.db.admin, FENCE);

      const ownerUrl = new URL(d.url.toString());
      ownerUrl.username = role;
      ownerUrl.password = password;
      await withDumpStandIn(async (marker) => {
        // The owner can read the fence row (it has no row policy), so the fence is reported first.
        const fenced = await createBackup({ dir: out, databaseUrl: ownerUrl.toString(), env: process.env, log: () => {} }).catch(
          (err: Error) => err,
        );
        expect(fenced).toBeInstanceOf(Error);
        expect((fenced as Error).message).toMatch(/has not finished reconciling erasure exclusions/);
        expect(await readdir(out)).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();

        // With no fence, the role check still refuses the owner before a dump: pg_dump needs BYPASSRLS.
        await d.db.admin.query('DELETE FROM public.restore_fence');
        const unfenced = await createBackup({
          dir: out,
          databaseUrl: ownerUrl.toString(),
          env: process.env,
          log: () => {},
        }).catch((err: Error) => err);
        expect(unfenced).toBeInstanceOf(Error);
        expect((unfenced as Error).message).toMatch(/is not SUPERUSER and does not have BYPASSRLS/);
        expect(await readdir(out)).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();
      });
    } finally {
      await d.db.admin.query(`REASSIGN OWNED BY ${role} TO "${owner}"`).catch(() => {});
      await d.db.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await d.db.admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('names the SELECT grant when a BYPASSRLS backup role cannot read the fence table', async () => {
    const d = await createDisposableDb('backup_fence_grant');
    const out = await mkdtemp(join(tmpdir(), 'am-fence-grant-'));
    const role = `am_fence_grant_${randomBytes(4).toString('hex')}`;
    try {
      await raiseRestoreFence(d.db.admin, FENCE);
      // A dedicated backup role that may dump (BYPASSRLS) but was never granted SELECT on the
      // fence table. The refusal has to say which grant fixes it.
      await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fence-grant-password' BYPASSRLS`);
      const roleUrl = new URL(d.url.toString());
      roleUrl.username = role;
      roleUrl.password = 'fence-grant-password';
      await withDumpStandIn(async (marker) => {
        const error = await createBackup({ dir: out, databaseUrl: roleUrl.toString(), env: process.env, log: () => {} }).catch(
          (err: Error) => err,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('GRANT SELECT ON public.restore_fence');
        expect(await readdir(out)).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();
      });
    } finally {
      await d.db.admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

// The backup holds the same advisory key a restore takes exclusively, for its whole capture: the
// fence read, the Postgres dump, the optional ClickHouse export and the archive/manifest write. A
// restore can therefore not pass its own checks between a backup's fence read and its dump, and a
// backup cannot read the database while a restore replaces it.
describe.skipIf(!hasTestDatabase())('a backup and a restore exclude each other', () => {
  it('refuses a backup while a restore holds the lock, before anything is written', async () => {
    const d = await createDisposableDb('backup_interlock_restore');
    const out = await mkdtemp(join(tmpdir(), 'am-interlock-restore-'));
    const restore = await acquireRestoreSessionLock(d.url.toString());
    try {
      await withDumpStandIn(async (marker) => {
        const error = await createBackup({ dir: out, databaseUrl: d.url.toString(), env: process.env, log: () => {} }).catch(
          (err: Error) => err,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/A restore is running/);
        expect((error as Error).message).toMatch(/wait for .*restore.* to finish|retry/i);
        expect(await readdir(out)).toEqual([]);
        await expect(stat(marker)).rejects.toThrow();
      });
    } finally {
      await restore.release();
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('makes a restore wait for a backup, name it, and proceed once it ends', async () => {
    const d = await createDisposableDb('backup_interlock_wait');
    const out = await mkdtemp(join(tmpdir(), 'am-interlock-wait-'));
    const databaseUrl = d.url.toString();
    try {
      await withDumpStandIn(async () => {
        const { dir } = await createBackup({ dir: out, databaseUrl, env: process.env, log: () => {} });
        const interlock = await acquireBackupInterlock(databaseUrl);
        const messages: string[] = [];
        try {
          const started = Date.now();
          // The restore retries the exclusive lock until its drain bound and names the backup that
          // holds the shared one, instead of the generic "another restore is running" message.
          await expect(acquireRestoreSessionLock(databaseUrl, { waitMs: 1_000, log: (line) => messages.push(line) })).rejects.toThrow(
            /a backup is still running.*am-backup/,
          );
          expect(Date.now() - started).toBeGreaterThanOrEqual(900);
          expect(messages.some((line) => line.includes('backup'))).toBe(true);
        } finally {
          await interlock.release();
        }
        // The same restore takes the lock as soon as the backup's interlock is gone.
        const restore = await acquireRestoreSessionLock(databaseUrl, { waitMs: 1_000 });
        await restore.release();
        // The backup directory in this test is a stand-in and was never restored.
        expect(dir).toContain('am-manual-');
      });
    } finally {
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('makes `am restore` wait for a backup and refuse with the backup diagnostic', async () => {
    const d = await createDisposableDb('backup_interlock_restore_backup');
    const out = await mkdtemp(join(tmpdir(), 'am-interlock-restore-backup-'));
    const databaseUrl = d.url.toString();
    const messages: string[] = [];
    try {
      await withDumpStandIn(async () => {
        const { dir } = await createBackup({ dir: out, databaseUrl, env: process.env, log: () => {} });
        const interlock = await acquireBackupInterlock(databaseUrl);
        try {
          const started = Date.now();
          // `restoreBackup` passes its drain bound to the lock, so the wait and the message match
          // the drain diagnostic from #1214.
          await expect(
            restoreBackup({
              dir,
              databaseUrl,
              env: process.env,
              skipKeyCheck: true,
              drainTimeoutMs: 1_000,
              log: (line) => messages.push(line),
            }),
          ).rejects.toThrow(/a backup is still running.*am-backup/);
          expect(Date.now() - started).toBeGreaterThanOrEqual(900);
          expect(messages.some((line) => line.includes('waiting for a running backup'))).toBe(true);
        } finally {
          await interlock.release();
        }
      });
    } finally {
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('discards the partial output when the interlock is lost mid-backup', async () => {
    const d = await createDisposableDb('backup_interlock_lost');
    const out = await mkdtemp(join(tmpdir(), 'am-interlock-lost-'));
    try {
      await withHangingDumpStandIn(async (marker) => {
        const running = createBackup({ dir: out, databaseUrl: d.url.toString(), env: process.env, log: () => {} }).then(
          (value) => ({ ok: true as const, value }),
          (error: Error) => ({ ok: false as const, error }),
        );
        await waitForPath(marker);
        await terminateBackupInterlock(d.url.toString());
        const result = await running;
        expect(result.ok).toBe(false);
        expect((result as { error: Error }).error.message).toMatch(/backup lock was lost|discarded|terminat|connection/i);
        // The temporary directory and its dump are gone: no archive, no manifest entry.
        expect(await readdir(out)).toEqual([]);
      });
    } finally {
      await d.close();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
