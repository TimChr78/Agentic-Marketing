import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestMigration, migrate } from '@agentic-marketing/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run as backupRun } from '../src/ops/backup';
import { type BackupManifest, cronMatches, exportClickHouse, parseCron, restoreClickHouse } from '../src/ops/backup-lib';
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

async function clickhouse(query: string, database?: string): Promise<string> {
  const url = new URL(chUrl);
  url.searchParams.set('query', query);
  if (database) url.searchParams.set('database', database);
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
      expect(tables[0].bytes).toBeGreaterThan(0);
      expect(tables[0].sha256).toMatch(/^[0-9a-f]{64}$/);

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

  it('writes a complete manifest with a migration head', () => {
    expect(manifest.format).toBe(1);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.migrationHead).toBe(latestMigration());
    expect(manifest.postgres.file).toBe('postgres.dump');
    expect(manifest.postgres.bytes).toBeGreaterThan(0);
    expect(manifest.postgres.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restores the deleted Postgres row', async () => {
    expect(await withEnv(env, () => restoreRun([backupPath, '--yes']))).toBe(0);
    const { rows } = await pool.query<{ note: string }>('SELECT note FROM backup_marker WHERE id = 1');
    expect(rows[0]?.note).toBe('before');
    const { rows: grants } = await pool.query<{ can: boolean }>("SELECT has_table_privilege($1, 'backup_marker', 'SELECT') AS can", [role]);
    expect(grants[0]?.can).toBe(true);
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
});
