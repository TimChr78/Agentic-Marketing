import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { raiseRestoreFence } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { backupHealth, createBackup, readScheduleStatus, runScheduledBackups, type ScheduleStatus } from '../src/ops/backup-lib';

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

/** Waits until the scheduler loop has recorded one completed run. */
async function waitForScheduledRun(dir: string): Promise<ScheduleStatus> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await readScheduleStatus(dir);
    if (status?.lastRunAt) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the scheduler did not complete a run within 90s');
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
        const status = await waitForScheduledRun(dir);
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
});
