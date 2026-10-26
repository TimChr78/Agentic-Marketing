import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastServerVersion, latestMigration, migrate, recordServerVersion } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
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
  restoreBackup,
  restoreClickHouse,
  writeScheduleStatus,
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
      expect((await backupHealth({ dir })).ok).toBe(true);
      expect(await backupHealth({ dir, now: new Date(Date.now() + 3 * 60_000) })).toMatchObject({ ok: false });

      await writeScheduleStatus(dir, { ...status, lastOk: false, lastError: 'pg_dump failed' });
      const failed = await backupHealth({ dir });
      expect(failed.ok).toBe(false);
      expect(failed.reason).toMatch(/pg_dump failed/);
      expect((await stat(join(dir, '.schedule-status.json'))).mode & 0o777).toBe(0o600);
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

  it('restores the deleted Postgres row', async () => {
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);
    const { rows } = await pool.query<{ note: string }>('SELECT note FROM backup_marker WHERE id = 1');
    expect(rows[0]?.note).toBe('before');
    const { rows: grants } = await pool.query<{ can: boolean }>("SELECT has_table_privilege($1, 'backup_marker', 'SELECT') AS can", [role]);
    expect(grants[0]?.can).toBe(true);
  }, 120_000);

  it('falls back to the migration head when server_versions is empty', async () => {
    await pool.query('DELETE FROM server_versions');
    expect(await lastServerVersion(dbUrl.toString())).toBe('0.2.6');
  });

  it('names a pre-upgrade backup after the newest release in a migration-head range', async () => {
    // 0.2.4 left no server_versions row and shares its head with 0.2.3, so the data version is a
    // range. The name takes the newest release; the manifest keeps the range and says why.
    await pool.query('DROP TABLE server_versions');
    await pool.query("DELETE FROM schema_migrations WHERE version = '0028_server_versions.sql'");
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
