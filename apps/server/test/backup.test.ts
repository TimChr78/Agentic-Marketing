import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastServerVersion, latestMigration, migrate, recordServerVersion, releaseForMigrationHead } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { localKeyProvider, open, seal } from '@agentic-marketing/secrets';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run as backupRun } from '../src/ops/backup';
import {
  type BackupManifest,
  backupHealth,
  createBackup,
  cronMatches,
  exportClickHouse,
  listBackups,
  nextCronRun,
  parseCron,
  readScheduleStatus,
  readVerifyStatus,
  restoreBackup,
  restoreClickHouse,
  verifyBackup,
  writeScheduleStatus,
  writeVerifyStatus,
} from '../src/ops/backup-lib';
import { run as restoreRun } from '../src/ops/restore';

function toolMajor(tool: string): number {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  return Number(/\(PostgreSQL\) (\d+)/.exec(result.stdout)?.[1] ?? 0);
}

const pgToolsReady = toolMajor('pg_dump') >= 16 && toolMajor('pg_restore') >= 16;
const chUrl = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const chUp = await fetch(new URL('/ping', chUrl), { signal: AbortSignal.timeout(2_000) })
  .then((response) => response.ok)
  .catch(() => false);

async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function clickhouse(query: string, database?: string, settings: Record<string, string> = {}): Promise<string> {
  const url = new URL(chUrl);
  url.searchParams.set('query', query);
  if (database) url.searchParams.set('database', database);
  for (const [key, value] of Object.entries(settings)) url.searchParams.set(key, value);
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) throw new Error(`ClickHouse: ${response.status} ${await response.text()}`);
  return response.text();
}

describe('cron matcher', () => {
  it('matches steps, lists and ranges', () => {
    const spec = parseCron('5,10-20/5 0-6/2 * * *');
    expect(spec.minute).toEqual([5, 10, 15, 20]);
    expect(spec.hour).toEqual([0, 2, 4, 6]);
    expect(cronMatches(spec, new Date('2026-10-26T04:15:00Z'))).toBe(true);
    expect(cronMatches(spec, new Date('2026-10-26T05:15:00Z'))).toBe(false);
    expect(cronMatches(spec, new Date('2026-10-26T04:16:00Z'))).toBe(false);
  });

  it('matches weekday ranges and treats Sunday as both 0 and 7', () => {
    const weekdays = parseCron('0 3 * * 1-5');
    expect(cronMatches(weekdays, new Date('2026-10-26T03:00:00Z'))).toBe(true); // Monday
    expect(cronMatches(weekdays, new Date('2026-11-01T03:00:00Z'))).toBe(false); // Sunday
    expect(parseCron('0 3 * * 7').dayOfWeek).toEqual([0]);
    expect(cronMatches(parseCron('0 3 * * 0'), new Date('2026-11-01T03:00:00Z'))).toBe(true);
  });

  it('uses OR when day-of-month and day-of-week are both restricted', () => {
    const spec = parseCron('0 0 1 * 1');
    expect(cronMatches(spec, new Date('2026-10-01T00:00:00Z'))).toBe(true); // first of the month
    expect(cronMatches(spec, new Date('2026-10-05T00:00:00Z'))).toBe(true); // Monday
    expect(cronMatches(spec, new Date('2026-10-06T00:00:00Z'))).toBe(false);
  });

  it('rejects invalid expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *', 'foo * * * *', '1,,2 * * * *', '1-2-3 * * * *', '-5 * * * *'])
      expect(() => parseCron(bad)).toThrow();
  });

  it('finds the next matching minute', () => {
    const next = nextCronRun(parseCron('30 3 * * *'), new Date('2026-10-26T03:10:00Z'));
    expect(next.toISOString()).toBe('2026-10-26T03:30:00.000Z');
  });
});

describe('scheduler health', () => {
  it('reports a missing, stale, failed or healthy heartbeat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'am-health-'));
    try {
      expect((await backupHealth({ dir })).ok).toBe(false);
      expect((await backupHealth({ dir })).reason).toMatch(/no scheduler heartbeat/);

      const status = { lastRunAt: new Date().toISOString(), lastOk: true, nextRunAt: '2026-10-27T03:30:00.000Z' };
      await writeScheduleStatus(dir, status);
      expect(await readScheduleStatus(dir)).toEqual(status);
      // A heartbeat alone is not enough: nothing has checked that a backup can be read (#145).
      const unverified = await backupHealth({ dir });
      expect(unverified.ok).toBe(false);
      expect(unverified.reason).toMatch(/no successful backup verification/);

      await writeVerifyStatus(dir, { verifiedAt: new Date().toISOString(), backup: 'am-manual-test' });
      expect((await readVerifyStatus(dir))?.backup).toBe('am-manual-test');
      expect((await backupHealth({ dir })).ok).toBe(true);
      expect(await backupHealth({ dir, now: new Date(Date.now() + 3 * 60_000) })).toMatchObject({ ok: false });

      const staleVerify = new Date(Date.now() - 40 * 86_400_000).toISOString();
      await writeVerifyStatus(dir, { verifiedAt: staleVerify, backup: 'am-manual-test' });
      const stale = await backupHealth({ dir });
      expect(stale.ok).toBe(false);
      expect(stale.reason).toMatch(/last successful backup verification .* older/);
      expect(await backupHealth({ dir, env: { BACKUP_VERIFY_MAX_AGE_DAYS: '3650' } })).toMatchObject({ ok: true });
      await writeVerifyStatus(dir, { verifiedAt: new Date().toISOString(), backup: 'am-manual-test' });

      await writeScheduleStatus(dir, { ...status, lastOk: false, lastError: 'pg_dump failed' });
      const failed = await backupHealth({ dir });
      expect(failed.ok).toBe(false);
      expect(failed.reason).toMatch(/pg_dump failed/);
      expect((await stat(join(dir, '.schedule-status.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, '.verify-status.json'))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!chUp)('ClickHouse export and restore', () => {
  it('round-trips one MergeTree table', async () => {
    const database = `am_backup_ch_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const out = await mkdtemp(join(tmpdir(), 'am-ch-backup-'));
    try {
      await clickhouse(`CREATE DATABASE ${database}`);
      await clickhouse(`CREATE TABLE ${database}.events (id UInt64, note String) ENGINE = MergeTree ORDER BY id`);
      await clickhouse(`INSERT INTO ${database}.events VALUES (1, 'before')`);

      const tables = await exportClickHouse({ url: chUrl, database, outDir: out });
      expect(tables.map((table) => table.name)).toEqual(['events']);
      expect(tables[0].totalRowsBefore).toBe(1);
      expect(tables[0].files).toHaveLength(1);
      expect(tables[0].files[0].rows).toBe(1);
      expect(tables[0].files[0].bytes).toBeGreaterThan(0);
      expect(tables[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

      await clickhouse(`TRUNCATE TABLE ${database}.events`);
      await restoreClickHouse({ runDir: out, tables, url: chUrl, database });

      const row = JSON.parse((await clickhouse(`SELECT id, note FROM ${database}.events FORMAT JSONEachRow`)).trim());
      expect(Number(row.id)).toBe(1);
      expect(row.note).toBe('before');
    } finally {
      await clickhouse(`DROP DATABASE IF EXISTS ${database}`).catch(() => {});
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!pgToolsReady)('backup and restore', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const dbName = `am_backup_${suffix}`;
  const role = `am_app_bk_${suffix}`;
  const password = 'backup_test_password';
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${dbName}`;
  const maintenanceUrl = new URL(base);
  maintenanceUrl.pathname = '/postgres';

  let pool: pg.Pool;
  let backupDir: string;
  let backupPath: string;
  let manifest: BackupManifest;

  const env = {
    DATABASE_URL: dbUrl.toString(),
    APP_DB_ROLE: role,
    APP_DB_PASSWORD: password,
  };

  beforeAll(async () => {
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${dbName}`);
    await maintenance.end();

    pool = new pg.Pool({ connectionString: dbUrl.toString() });
    await migrate(pool, { appRolePassword: password, appRole: role });
    // Pretend 0.2.4 ran this database: the backup must label the data with that, not with the
    // build that takes the backup.
    await recordServerVersion(pool, '0.2.4');
    await pool.query('CREATE TABLE backup_marker (id integer PRIMARY KEY, note text NOT NULL)');
    await pool.query("INSERT INTO backup_marker VALUES (1, 'before')");
    // pg_restore must bring this grant back too; the app connects as this role, not as the owner.
    await pool.query(`GRANT SELECT ON backup_marker TO ${role}`);

    backupDir = await mkdtemp(join(tmpdir(), 'am-backup-'));
    const code = await withEnv(env, () => backupRun(['--to', backupDir]));
    expect(code).toBe(0);

    const entry = (await readdir(backupDir)).find((name) => name.startsWith('am-'));
    if (!entry) throw new Error('backup did not create an am-* directory');
    backupPath = join(backupDir, entry);
    manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')) as BackupManifest;

    await pool.query('DELETE FROM backup_marker');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${role}`);
    await maintenance.end();
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  }, 120_000);

  it('writes a format 2 manifest with kind, versions and a migration head', () => {
    expect(manifest.format).toBe(2);
    expect(manifest.kind).toBe('manual');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.fromVersion).toBe('0.2.4');
    expect(manifest.migrationHead).toBe(latestMigration());
    expect(manifest.postgres.file).toBe('postgres.dump');
    expect(manifest.postgres.bytes).toBeGreaterThan(0);
    expect(manifest.postgres.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.clickhouse).toBeUndefined();
  });

  it('names manual and pre-upgrade backups after their kind and versions', async () => {
    expect(backupPath.split('/').pop()).toMatch(/^am-manual-\d+\.\d+\.\d+-\d{8}T\d{6}Z$/);
    // The CLI always takes a manual backup; exercise the pre-upgrade name through createBackup.
    const { dir } = await withEnv(env, () => createBackup({ dir: backupDir, kind: 'pre-upgrade', env: process.env, log: () => {} }));
    expect(dir.split('/').pop()).toMatch(/^am-pre-upgrade-0\.2\.4-to-\d+\.\d+\.\d+-\d{8}T\d{6}Z$/);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('creates private directories and files', async () => {
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(backupPath, 'postgres.dump'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(backupPath, 'manifest.json'))).mode & 0o777).toBe(0o600);
  });

  it('lists backups newest first with their kind and data version', async () => {
    const listings = await listBackups(backupDir);
    expect(listings[0].name).toBe(backupPath.split('/').pop());
    expect(listings[0]).toMatchObject({ kind: 'manual', dataVersion: '0.2.4', clickhouse: 'no' });
    expect(listings[0].bytes).toBeGreaterThan(0);
  });

  it('verifies a good backup without touching a database (#145)', async () => {
    const result = await verifyBackup({ dir: backupPath, env: process.env, log: () => {} });
    expect(result.manifest.postgres.file).toBe('postgres.dump');
    const status = await readVerifyStatus(backupDir);
    expect(status?.backup).toBe(backupPath.split('/').pop());
    expect(status?.verifiedAt).toBeTruthy();
    expect((await stat(join(backupDir, '.verify-status.json'))).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('fails verification on a tampered file with the file and both hashes (#145)', async () => {
    const bad = join(backupDir, 'bad-verify');
    await cp(backupPath, bad, { recursive: true });
    const dump = await readFile(join(bad, 'postgres.dump'));
    dump[dump.length - 1] ^= 0xff;
    await writeFile(join(bad, 'postgres.dump'), dump);
    const error = await verifyBackup({ dir: bad, env: process.env, log: () => {} }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/postgres\.dump does not match its sha256 \(expected [0-9a-f]{64}, got [0-9a-f]{64}\)/);
    await rm(bad, { recursive: true, force: true });
  }, 60_000);

  it('restores the deleted Postgres row', async () => {
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);
    const { rows } = await pool.query<{ note: string }>('SELECT note FROM backup_marker WHERE id = 1');
    expect(rows[0]?.note).toBe('before');
    const { rows: grants } = await pool.query<{ can: boolean }>("SELECT has_table_privilege($1, 'backup_marker', 'SELECT') AS can", [role]);
    expect(grants[0]?.can).toBe(true);
  }, 120_000);

  it('falls back to the migration head when server_versions is empty', async () => {
    await pool.query('DELETE FROM server_versions');
    // The release of the newest migration, whatever this build's newest is.
    expect(await lastServerVersion(dbUrl.toString())).toBe(releaseForMigrationHead(latestMigration() ?? null));
  });

  it('names a pre-upgrade backup after the newest release in a migration-head range', async () => {
    // 0.2.4 left no server_versions row and shares its head with 0.2.3, so the data version is a
    // range. The name takes the newest release; the manifest keeps the range and says why.
    await pool.query('DROP TABLE server_versions');
    await pool.query("DELETE FROM schema_migrations WHERE version > '0027_journey_consent_exits.sql'");
    const { dir, manifest: preUpgrade } = await withEnv(env, () =>
      createBackup({ dir: backupDir, kind: 'pre-upgrade', env: process.env, log: () => {} }),
    );
    expect(dir.split('/').pop()).toMatch(/^am-pre-upgrade-0\.2\.4-to-\d+\.\d+\.\d+-\d{8}T\d{6}Z$/);
    expect(preUpgrade.fromVersion).toBe('0.2.3–0.2.4 (from migration head)');
    expect(preUpgrade.migrationHead).toBe('0027_journey_consent_exits.sql');
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('refuses a newer migration head unless forced', async () => {
    const newer = join(backupDir, 'newer');
    await cp(backupPath, newer, { recursive: true });
    await writeFile(join(newer, 'manifest.json'), JSON.stringify({ ...manifest, version: '99.0.0', migrationHead: '9999_future' }));
    expect(await withEnv(env, () => restoreRun([newer, '--yes']))).toBe(1);
    expect(await withEnv(env, () => restoreRun([newer, '--yes', '--force']))).toBe(0);
  }, 120_000);

  it('refuses a dump whose sha256 does not match', async () => {
    const bad = join(backupDir, 'bad');
    await cp(backupPath, bad, { recursive: true });
    const dump = await readFile(join(bad, 'postgres.dump'));
    dump[dump.length - 1] ^= 0xff;
    await writeFile(join(bad, 'postgres.dump'), dump);
    expect(await withEnv(env, () => restoreRun([bad, '--yes']))).toBe(1);
  }, 60_000);

  it('lists a format 1 backup as legacy with an unusable ClickHouse part', async () => {
    const old = join(backupDir, 'am-legacy');
    await cp(backupPath, old, { recursive: true });
    await writeFile(join(old, 'clickhouse.native'), 'not a real export');
    const format1 = {
      format: 1,
      version: '0.2.4',
      migrationHead: manifest.migrationHead,
      createdAt: manifest.createdAt,
      postgres: manifest.postgres,
      clickhouse: {
        tables: [{ name: 'events', file: 'clickhouse.native', rows: 0, bytes: 17, sha256: '0'.repeat(64) }],
      },
    };
    await writeFile(join(old, 'manifest.json'), JSON.stringify(format1));
    const legacy = (await listBackups(backupDir)).find((entry) => entry.name === 'am-legacy');
    expect(legacy).toMatchObject({ kind: 'legacy', dataVersion: '0.2.4', clickhouse: 'empty (0.2.4, unusable)' });
    await expect(
      restoreBackup({ dir: old, clickhouse: true, databaseUrl: dbUrl.toString(), env: process.env, log: () => {} }),
    ).rejects.toThrow(/made by 0\.2\.4, whose ClickHouse export is empty under row policies \(#129\)/);
  }, 60_000);
});

describe.skipIf(!pgToolsReady)('restore replays erasures (#144)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const dbName = `am_backup_erasure_${suffix}`;
  const role = `am_app_er_${suffix}`;
  const password = 'backup_test_password';
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${dbName}`;
  const maintenanceUrl = new URL(base);
  maintenanceUrl.pathname = '/postgres';
  const workspaceId = randomUUID();
  const profileId = 'prf_erased0000000000000000000000000';
  const erasureId = 'era_restore000000000000000000000';
  const userHash = 'a'.repeat(64);
  const emailHash = 'b'.repeat(64);

  let pool: pg.Pool;
  let backupDir: string;
  let backupPath: string;

  const env = {
    DATABASE_URL: dbUrl.toString(),
    APP_DB_ROLE: role,
    APP_DB_PASSWORD: password,
  };

  beforeAll(async () => {
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${dbName}`);
    await maintenance.end();

    pool = new pg.Pool({ connectionString: dbUrl.toString() });
    await migrate(pool, { appRolePassword: password, appRole: role });
    await pool.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Erased person', 'none')", [workspaceId]);
    await pool.query("INSERT INTO profiles (workspace_id, id, traits) VALUES ($1, $2, '{}')", [workspaceId, profileId]);
    await pool.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id) VALUES
         ($1, 'user_id', 'erased-person', $2),
         ($1, 'anonymous_id', 'erased-anon', $2),
         ($1, 'email', $3, $2)`,
      [workspaceId, profileId, emailHash],
    );
    // A browser registration and an app registration for the same person (#280): neither has a
    // foreign key to profiles, so only an explicit deletion removes them.
    await pool.query(`INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key) VALUES ($1, 'dk_erase_test', 'kek_test', '\\x00')`, [
      workspaceId,
    ]);
    await pool.query(
      `INSERT INTO push_subscriptions (workspace_id, id, kind, anonymous_id, user_id, token_hash, secrets, secrets_key_id) VALUES
         ($1, 'psh_erased_user', 'web', NULL, 'erased-person', $2, '\\x00', 'dk_erase_test'),
         ($1, 'psh_erased_anon', 'web', 'erased-anon', NULL, $3, '\\x00', 'dk_erase_test')`,
      [workspaceId, 'c'.repeat(64), 'd'.repeat(64)],
    );

    backupDir = await mkdtemp(join(tmpdir(), 'am-backup-erasure-'));
    expect(await withEnv(env, () => backupRun(['--to', backupDir]))).toBe(0);
    const entry = (await readdir(backupDir)).find((name) => name.startsWith('am-'));
    if (!entry) throw new Error('backup did not create an am-* directory');
    backupPath = join(backupDir, entry);

    // Erase the person after the snapshot, exactly as profiles.erase leaves the live database:
    // their rows are gone and the erasure log has the profile id and the keyed tombstones.
    await pool.query('DELETE FROM push_subscriptions WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM identifiers WHERE workspace_id = $1 AND profile_id = $2', [workspaceId, profileId]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = $2', [workspaceId, profileId]);
    await pool.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, $3, 'user_tester', 'Erasure request by e-mail on 2026-10-31', '{"profiles":1,"identifiers":3,"consentRecords":0}')`,
      [workspaceId, erasureId, [profileId]],
    );
    await pool.query(
      `INSERT INTO erasure_tombstones (workspace_id, ident_hash, erased_at, erasure_id)
       VALUES ($1, $2, now(), $3), ($1, $4, now(), $3)`,
      [workspaceId, userHash, erasureId, emailHash],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${role}`);
    await maintenance.end();
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  }, 120_000);

  it('does not resurrect a person erased after the backup', async () => {
    // The snapshot still contains the profile, their identifiers and their profile key.
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);

    expect((await pool.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [workspaceId, profileId])).rowCount).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM identifiers WHERE workspace_id = $1 AND profile_id = $2', [workspaceId, profileId])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM profile_keys WHERE workspace_id = $1 AND profile_id = $2', [workspaceId, profileId])).rowCount,
    ).toBe(0);
    // Their browser and app registrations stay gone: push_subscriptions has no foreign key to
    // profiles, so the restore replay has to delete them itself (#280).
    expect((await pool.query('SELECT 1 FROM push_subscriptions WHERE workspace_id = $1', [workspaceId])).rowCount).toBe(0);
    // The e-mail suppression hash comes back, so the person is never contacted again.
    const suppress = await pool.query<{ value_hash: string; reason: string }>(
      'SELECT value_hash, reason FROM suppressions WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(suppress.rows).toEqual([{ value_hash: emailHash, reason: 'erased' }]);
    // The erasure record and both tombstones survive the restore.
    expect((await pool.query('SELECT 1 FROM erasures WHERE workspace_id = $1 AND id = $2', [workspaceId, erasureId])).rowCount).toBe(1);
    const tombstones = await pool.query<{ ident_hash: string }>(
      'SELECT ident_hash FROM erasure_tombstones WHERE workspace_id = $1 ORDER BY ident_hash',
      [workspaceId],
    );
    expect(tombstones.rows.map((row) => row.ident_hash)).toEqual([userHash, emailHash].sort());

    // Replaying the same log again (or restoring twice) changes nothing.
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);
    expect((await pool.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [workspaceId, profileId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM erasure_tombstones WHERE workspace_id = $1', [workspaceId])).rowCount).toBe(2);
  }, 180_000);
});

describe.skipIf(!pgToolsReady)('restore verifies the master key (#143)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const dbName = `am_backup_key_${suffix}`;
  const role = `am_app_key_${suffix}`;
  const password = 'backup_test_password';
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${dbName}`;
  const maintenanceUrl = new URL(base);
  maintenanceUrl.pathname = '/postgres';
  const workspaceId = randomUUID();
  const dataKey = Buffer.alloc(32, 3);
  const secretValue = 'provider-api-key-that-must-survive';
  // A and B are the KEKs before and after a rotation; neither is key material for this repository.
  const keyA = Buffer.alloc(32, 7).toString('base64');
  const keyB = Buffer.alloc(32, 9).toString('base64');
  const providerA = localKeyProvider(keyA);
  const providerBWithPrevious = localKeyProvider(keyB, [keyA]);

  let pool: pg.Pool;
  let backupDir: string;
  let backupPath: string;
  let manifest: BackupManifest;

  const env = {
    DATABASE_URL: dbUrl.toString(),
    APP_DB_ROLE: role,
    APP_DB_PASSWORD: password,
    KEY_PROVIDER: 'local',
    MASTER_KEY: keyA,
  };

  beforeAll(async () => {
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${dbName}`);
    await maintenance.end();

    pool = new pg.Pool({ connectionString: dbUrl.toString() });
    await migrate(pool, { appRolePassword: password, appRole: role });
    await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Key check')", [workspaceId]);
    const wrapped = await providerA.wrap(dataKey);
    await pool.query(
      "INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, purpose) VALUES ($1, 'dk_key_check', $2, $3, 'secrets')",
      [workspaceId, providerA.id, wrapped],
    );
    const sealed = seal(dataKey, Buffer.from(secretValue, 'utf8'));
    await pool.query(
      `INSERT INTO secrets (workspace_id, name, data_key_id, iv, ciphertext, auth_tag, updated_by)
       VALUES ($1, 'llm.provider.api_key', 'dk_key_check', $2, $3, $4, 'user_tester')`,
      [workspaceId, sealed.iv, sealed.ciphertext, sealed.authTag],
    );
    // A row in an existing table records whether a refused restore touched the database: an extra
    // table created after the backup would survive pg_restore --clean (it is not in the dump).
    await pool.query('CREATE TABLE key_marker (note text NOT NULL)');
    await pool.query("INSERT INTO key_marker VALUES ('before')");

    backupDir = await mkdtemp(join(tmpdir(), 'am-backup-key-'));
    expect(await withEnv(env, () => backupRun(['--to', backupDir]))).toBe(0);
    const entry = (await readdir(backupDir)).find((name) => name.startsWith('am-'));
    if (!entry) throw new Error('backup did not create an am-* directory');
    backupPath = join(backupDir, entry);
    manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')) as BackupManifest;
    await pool.query("UPDATE key_marker SET note = 'live'");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${role}`);
    await maintenance.end();
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  }, 120_000);

  it('records a key reference and a sealed key check, never the key', async () => {
    expect(manifest.key?.reference).toBe(providerA.id);
    expect(manifest.key?.check?.kekId).toBe(providerA.id);
    expect(manifest.key?.check?.wrapped).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const text = await readFile(join(backupPath, 'manifest.json'), 'utf8');
    expect(text).not.toContain(keyA);
    expect(text).not.toContain(secretValue);
  });

  it('refuses a wrong key before touching the database, naming MASTER_KEY_PREVIOUS', async () => {
    expect(await withEnv({ ...env, MASTER_KEY: keyB }, () => restoreRun([backupPath, '--yes']))).toBe(1);
    await expect(restoreBackup({ dir: backupPath, env: { ...process.env, ...env, MASTER_KEY: keyB }, log: () => {} })).rejects.toThrow(
      /MASTER_KEY_PREVIOUS/,
    );
    // The marker row written after the snapshot is still there: pg_restore never ran.
    const { rows } = await pool.query<{ note: string }>('SELECT note FROM key_marker');
    expect(rows).toEqual([{ note: 'live' }]);
    expect((await pool.query('SELECT 1 FROM data_keys WHERE workspace_id = $1', [workspaceId])).rowCount).toBe(1);
  }, 60_000);

  it('restores an old backup with the old key in MASTER_KEY_PREVIOUS and can read its secret', async () => {
    expect(await withEnv({ ...env, MASTER_KEY: keyB, MASTER_KEY_PREVIOUS: keyA }, () => restoreRun([backupPath, '--yes']))).toBe(0);
    expect((await pool.query<{ note: string }>('SELECT note FROM key_marker')).rows).toEqual([{ note: 'before' }]);
    const key = await pool.query<{ kek_id: string; wrapped_key: Buffer }>(
      'SELECT kek_id, wrapped_key FROM data_keys WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(key.rows).toHaveLength(1);
    const unwrapped = await providerBWithPrevious.unwrap(key.rows[0].wrapped_key, key.rows[0].kek_id);
    expect(unwrapped).toEqual(dataKey);
    const secret = await pool.query<{ iv: Buffer; ciphertext: Buffer; auth_tag: Buffer }>(
      "SELECT iv, ciphertext, auth_tag FROM secrets WHERE workspace_id = $1 AND name = 'llm.provider.api_key'",
      [workspaceId],
    );
    expect(
      open(unwrapped, { iv: secret.rows[0].iv, authTag: secret.rows[0].auth_tag, ciphertext: secret.rows[0].ciphertext }).toString(),
    ).toBe(secretValue);
  }, 120_000);

  it('restores with the current key alone', async () => {
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);
    expect((await pool.query<{ note: string }>('SELECT note FROM key_marker')).rows).toEqual([{ note: 'before' }]);
  }, 120_000);

  it('allows a deliberate wrong key only with --skip-key-check', async () => {
    expect(await withEnv({ ...env, MASTER_KEY: keyB }, () => restoreRun([backupPath, '--yes', '--skip-key-check']))).toBe(0);
    expect((await pool.query<{ note: string }>('SELECT note FROM key_marker')).rows).toEqual([{ note: 'before' }]);
  }, 120_000);
});

describe.skipIf(!pgToolsReady || !chUp)('ClickHouse backup under row policies (#129)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const dbName = `am_backup_ch_${suffix}`;
  const chDatabase = `am_backup_ch_${suffix}`;
  const role = `am_app_ch_${suffix}`;
  const password = 'backup_test_password';
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${dbName}`;
  const maintenanceUrl = new URL(base);
  maintenanceUrl.pathname = '/postgres';
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();

  let pool: pg.Pool;
  let backupDir: string;

  const env = {
    DATABASE_URL: dbUrl.toString(),
    APP_DB_ROLE: role,
    APP_DB_PASSWORD: password,
    CLICKHOUSE_URL: chUrl,
    CLICKHOUSE_DATABASE: chDatabase,
  };

  beforeAll(async () => {
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${dbName}`);
    await maintenance.end();

    pool = new pg.Pool({ connectionString: dbUrl.toString() });
    await migrate(pool, { appRolePassword: password, appRole: role });
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [workspaceA, 'A', workspaceB, 'B']);

    await clickhouse(`DROP DATABASE IF EXISTS ${chDatabase}`);
    // The same migration and row policies the server applies at startup.
    await migrateClickHouse(chUrl, chDatabase, () => {}, { rowPolicies: 'required' });
    for (const [workspace, count] of [
      [workspaceA, 3],
      [workspaceB, 2],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        await clickhouse(
          `INSERT INTO ${chDatabase}.events
             (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, properties, traits, context, consent)
           VALUES ('${workspace}', 'evt-${i}', 'src', now64(3), now64(3), 'track', 'page_viewed', 'anon-${i}', '', '{}', '{}', '{}', {})`,
        );
      }
    }
    // A policy with no setting must hide everything: this is the 0.2.4 bug in one assertion.
    expect(Number((await clickhouse(`SELECT count() FROM ${chDatabase}.events`)).trim())).toBe(0);

    backupDir = await mkdtemp(join(tmpdir(), 'am-backup-ch-'));
    expect(await withEnv(env, () => backupRun(['--to', backupDir, '--clickhouse']))).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${role}`);
    await maintenance.end();
    await clickhouse(`DROP DATABASE IF EXISTS ${chDatabase}`).catch(() => {});
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  }, 120_000);

  it('exports one non-empty file per workspace and restores the per-workspace counts', async () => {
    const dir = join(backupDir, (await readdir(backupDir)).find((name) => name.startsWith('am-')) ?? '');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
    expect(manifest.format).toBe(2);
    const events = manifest.clickhouse?.tables.find((table) => table.name === 'events');
    expect(events).toBeDefined();
    expect(events?.totalRowsBefore).toBe(5);
    expect(events?.files).toHaveLength(2);
    expect(events?.files.map((file) => file.workspace).sort()).toEqual([workspaceA, workspaceB].sort());
    for (const file of events?.files ?? []) {
      expect(file.rows).toBe(file.workspace === workspaceA ? 3 : 2);
      expect(file.file).toBe(`clickhouse/events/${file.workspace}.native`);
      expect(file.bytes).toBeGreaterThan(0);
      expect((await stat(join(dir, file.file))).mode & 0o777).toBe(0o600);
    }

    await clickhouse(`TRUNCATE TABLE ${chDatabase}.events`);
    expect(await withEnv(env, () => restoreRun([dir, '--yes', '--clickhouse']))).toBe(0);

    expect(Number((await clickhouse(`SELECT count() FROM ${chDatabase}.events`, chDatabase, { SQL_workspace: workspaceA })).trim())).toBe(
      3,
    );
    expect(Number((await clickhouse(`SELECT count() FROM ${chDatabase}.events`, chDatabase, { SQL_workspace: workspaceB })).trim())).toBe(
      2,
    );
    expect(Number((await clickhouse(`SELECT count() FROM ${chDatabase}.events`)).trim())).toBe(0);
  }, 180_000);
});
