import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { restoreBackup, restoreErasureLogPath, restoreLockPath, restoreTargetIdentity, retireRestoreCapture } from '../src/ops/backup-lib';

// #1009 review: a restore must not discard the live erasure log. The log is bound to the target
// database and backup, saved atomically next to the backup under an exclusive lock before the
// destructive step, unioned with the live log on every attempt, and retired only when it belongs
// to that attempt. These tests need no pg_restore: the replacement fails after the capture, which
// is enough to prove the log survives, is bound and is read again.

const dbs: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => {});
  for (const d of dbs) await d.close().catch(() => {});
});

type Disposable = Awaited<ReturnType<typeof createDisposableDb>>;
type Capture = {
  version: number;
  binding: { target: string; backup: string };
  log: {
    erasures: { id: string }[];
    cleanupJobs: { selectors: string; selectorKey: string }[];
    keys: { kind: string; keyValue: string; keyVersion: string }[];
  };
};

async function seed(d: Disposable, suffix: string): Promise<{ profile: string; erasureId: string }> {
  const profile = `prf_0000000000000000000000000000${suffix}`;
  const erasureId = `era_0000000000000000000000000000${suffix}`;
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profile]);
  await d.db.admin.query(
    `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
     VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'capture test', '{"profiles":1}')`,
    [d.workspace, erasureId, profile],
  );
  await d.db.admin.query(
    `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
     VALUES ($1, $2, ARRAY[$3]::text[], $4, $5, 'local-test')`,
    [d.workspace, erasureId, profile, Buffer.from(`selectors-${suffix}`), Buffer.from(`key-${suffix}`)],
  );
  // #1037: the durable erasure-key ledger is part of the captured log too.
  await d.db.admin.query(
    `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id) VALUES
       ($1, 'profile', $2, '', $3),
       ($1, 'email', $4, 'dk_capture', $3)`,
    [d.workspace, profile, erasureId, `hash-${suffix}`],
  );
  return { profile, erasureId };
}

async function makeBackup(): Promise<{ dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'am-capture-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'am-test');
  await mkdir(dir, { recursive: true });
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
  return { dir };
}

const envFor = (d: Disposable) => ({
  DATABASE_URL: d.url.toString(),
  APP_DB_ROLE: 'am_ops_test_app',
  APP_DB_PASSWORD: 'am_ops_test_password',
});

const readCapture = async (path: string): Promise<Capture> => JSON.parse(await readFile(path, 'utf8')) as Capture;

describe.skipIf(!hasTestDatabase())('restore capture binding and recovery (#1009 review)', () => {
  it('unions the saved log with the live log, keeping an erasure recorded after a failed attempt', async () => {
    const d = await createDisposableDb('restore_union');
    dbs.push(d);
    const first = await seed(d, 'ca01');
    const { dir } = await makeBackup();
    const capture = restoreErasureLogPath(dir);
    const target = await restoreTargetIdentity(d.url.toString());

    const env = envFor(d);
    const missingAppDbSecret = { ...env, APP_DB_PASSWORD: undefined };
    await expect(restoreBackup({ dir, env: missingAppDbSecret, skipKeyCheck: true, log: () => {} })).rejects.toThrow(/APP_DB_PASSWORD/);
    const saved = await readCapture(capture);
    expect(saved.version).toBe(2);
    expect(saved.binding.target).toBe(target);
    expect(saved.binding.backup).toContain(dir);
    expect(saved.log.erasures.map((e) => e.id)).toEqual([first.erasureId]);
    expect(saved.log.cleanupJobs[0]?.selectors).toBe(Buffer.from('selectors-ca01').toString('base64'));
    expect(saved.log.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'profile', keyValue: `prf_0000000000000000000000000000ca01`, keyVersion: '' }),
        expect.objectContaining({ kind: 'email', keyValue: 'hash-ca01', keyVersion: 'dk_capture' }),
      ]),
    );

    // A person erased after the failed attempt is not in the saved capture yet. The retry unions
    // the live log, so the capture (and the eventual replay) includes both.
    const second = await seed(d, 'ca02');
    await expect(restoreBackup({ dir, env, skipKeyCheck: true, log: () => {} })).rejects.toThrow();
    const merged = await readCapture(capture);
    expect(merged.log.erasures.map((e) => e.id).sort()).toEqual([first.erasureId, second.erasureId].sort());
    expect(merged.log.keys).toHaveLength(4);
  }, 120_000);

  it('refuses a capture bound to another target instead of reusing it', async () => {
    const a = await createDisposableDb('restore_bind_a');
    const b = await createDisposableDb('restore_bind_b');
    dbs.push(a, b);
    await seed(a, 'cb01');
    const { dir } = await makeBackup();
    const capture = restoreErasureLogPath(dir);
    await expect(
      restoreBackup({ dir, env: { ...envFor(a), APP_DB_PASSWORD: undefined }, skipKeyCheck: true, log: () => {} }),
    ).rejects.toThrow(/APP_DB_PASSWORD/);
    const foreign = await readCapture(capture);

    const error = await restoreBackup({ dir, databaseUrl: b.url.toString(), env: envFor(b), skipKeyCheck: true, log: () => {} }).catch(
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/belongs to .*not to/);
    expect((error as Error).message).toContain(capture);
    expect((await readCapture(capture)).binding).toEqual(foreign.binding);
  }, 120_000);

  it('refuses a second restore while the lock is held', async () => {
    const d = await createDisposableDb('restore_lock');
    dbs.push(d);
    await seed(d, 'cc01');
    const { dir } = await makeBackup();
    const lock = restoreLockPath(dir);
    await writeFile(lock, JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }));
    const error = await restoreBackup({ dir, env: envFor(d), skipKeyCheck: true, log: () => {} }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/another restore is using this backup/);
    expect((error as Error).message).toContain(lock);
    await rm(lock, { force: true });
  }, 60_000);

  it('retires only a capture with this attempt’s binding', async () => {
    const d = await createDisposableDb('restore_retire');
    dbs.push(d);
    await seed(d, 'cd01');
    const { dir } = await makeBackup();
    const capture = restoreErasureLogPath(dir);
    await expect(
      restoreBackup({ dir, env: { ...envFor(d), APP_DB_PASSWORD: undefined }, skipKeyCheck: true, log: () => {} }),
    ).rejects.toThrow(/APP_DB_PASSWORD/);
    expect((await stat(capture)).mode & 0o777).toBe(0o600);

    const own = (await readCapture(capture)).binding;
    await expect(retireRestoreCapture(capture, { target: 'pg:other/other', backup: 'other' })).resolves.toBe(false);
    await expect(stat(capture)).resolves.toBeTruthy();
    await expect(retireRestoreCapture(capture, own)).resolves.toBe(true);
    await expect(stat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
