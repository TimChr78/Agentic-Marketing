import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { restoreBackup, restoreErasureLogPath } from '../src/ops/backup-lib';

// #1009 review: a restore must not discard the live erasure log. The log is saved next to the
// backup before the destructive step, a missing APP_DB_PASSWORD is refused before the replacement,
// and a retry reuses the saved log instead of reading the already-restored database. This test
// needs no pg_restore: the replacement fails after the capture, which is enough to prove the log
// survives and is read again.

const dbs: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => {});
  for (const d of dbs) await d.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('restore keeps the live erasure log (#1009 review)', () => {
  it('refuses a missing password before replacing and reuses the saved log on retry', async () => {
    const d = await createDisposableDb('restore_capture');
    dbs.push(d);
    const profile = 'prf_0000000000000000000000000000ca01';
    const erasureId = 'era_0000000000000000000000000000ca01';
    const selectors = Buffer.from('sealed selectors for the capture test');
    const selectorKey = Buffer.from('wrapped service key for the capture test');
    await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profile]);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'capture test', '{"profiles":1}')`,
      [d.workspace, erasureId, profile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
       VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, 'local-test')`,
      [d.workspace, erasureId, profile, selectors, selectorKey],
    );

    const backupDir = await mkdtemp(join(tmpdir(), 'am-capture-'));
    cleanup.push(() => rm(backupDir, { recursive: true, force: true }));
    await mkdir(join(backupDir, 'am-test'), { recursive: true });
    const dir = join(backupDir, 'am-test');
    const dump = Buffer.from('not a real dump; the replacement is expected to fail before reading it');
    await writeFile(join(dir, 'postgres.dump'), dump);
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        format: 2,
        kind: 'manual',
        version: '0.15.0',
        fromVersion: '0.15.0',
        migrationHead: '0108_erasure_cleanup_jobs.sql',
        createdAt: new Date().toISOString(),
        postgres: { file: 'postgres.dump', bytes: dump.length, sha256: createHash('sha256').update(dump).digest('hex') },
      }),
    );

    const env = {
      DATABASE_URL: d.url.toString(),
      APP_DB_ROLE: 'am_ops_test_app',
      APP_DB_PASSWORD: 'am_ops_test_password',
    };
    const capture = restoreErasureLogPath(dir);
    // Postgres replacement fails (pg_restore is absent here), but only after the capture is saved.
    const firstLog: string[] = [];
    await expect(restoreBackup({ dir, env, skipKeyCheck: true, log: (m) => firstLog.push(m) })).rejects.toThrow();
    expect((await stat(capture)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(capture, 'utf8')) as {
      cleanupJobs: { selectors: string; selectorKey: string }[];
    };
    expect(saved.cleanupJobs).toHaveLength(1);
    expect(saved.cleanupJobs[0]?.selectors).toBe(selectors.toString('base64'));
    expect(saved.cleanupJobs[0]?.selectorKey).toBe(selectorKey.toString('base64'));
    expect(JSON.stringify(saved)).not.toContain('sealed selectors for the capture test');

    // Without the password the restore stops before touching Postgres, but it still reuses (and
    // keeps) the saved log, so a later attempt can replay it.
    const retryLog: string[] = [];
    const { APP_DB_PASSWORD: _omit, ...noPassword } = env;
    const error = await restoreBackup({ dir, env: noPassword, skipKeyCheck: true, log: (m) => retryLog.push(m) }).catch(
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/APP_DB_PASSWORD/);
    expect(retryLog.join('\n')).toContain('reusing the erasure log saved before an interrupted restore');
    expect((await stat(capture)).mode & 0o777).toBe(0o600);
    // The live database still has the erasure row, so nothing was replaced.
    expect((await d.db.admin.query('SELECT 1 FROM erasures WHERE workspace_id = $1 AND id = $2', [d.workspace, erasureId])).rowCount).toBe(
      1,
    );
  }, 120_000);
});
