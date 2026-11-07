import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyStale, cleanTestDatabases, clickHouseDropDecision } from './clean';
import { testDatabaseUrl } from './harness';

// `pnpm test:clean` must only touch the run it is asked to clean. Other checkouts share the same
// Postgres server, so a broad regex here deletes their databases mid-run (#515 review).

const root = fileURLToPath(new URL('../../../', import.meta.url));
const maintenanceUrl = testDatabaseUrl('postgres').toString();
const suffix = randomBytes(3).toString('hex');
const runA = `cleana${suffix}`;
const runB = `cleanb${suffix}`;
const dbA = `am_${runA}_test_clean`;
const dbB = `am_${runB}_test_clean`;

async function maintenance() {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();
  return client;
}

async function databaseNames(): Promise<string[]> {
  const client = await maintenance();
  try {
    const { rows } = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [
      [dbA, dbB],
    ]);
    return rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  const client = await maintenance();
  try {
    for (const name of [dbA, dbB]) await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
});

describe('stale classification', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const rows = [
    { name: 'am_run1_test_old', active: 0, created: new Date(now - 3 * 60 * 60_000) },
    { name: 'am_run1_test_busy', active: 2, created: new Date(now - 3 * 60 * 60_000) },
    { name: 'am_run1_test_young', active: 0, created: new Date(now - 5 * 60_000) },
    { name: 'am_run1_test_unknown_age', active: 0, created: null },
    { name: 'am_run2_test_current', active: 0, created: new Date(now - 3 * 60 * 60_000) },
    { name: 'am_production_not_a_test', active: 0, created: new Date(now - 3 * 60 * 60_000) },
  ];

  it('drops only old, idle databases from other runs and says why it skips the rest', () => {
    const result = classifyStale(rows, { run: 'run2', now, minAgeMs: 60 * 60_000 });
    expect(result.drop).toEqual(['am_run1_test_old']);
    expect(result.skipped).toEqual([
      { name: 'am_run1_test_busy', reason: '2 active connection(s)' },
      { name: 'am_run1_test_young', reason: 'younger than 60 minute(s)' },
      { name: 'am_run1_test_unknown_age', reason: 'age unknown' },
      { name: 'am_run2_test_current', reason: 'belongs to the current run' },
    ]);
  });

  it('never selects a database that is not shaped like a test database', () => {
    expect(classifyStale(rows, { run: 'run2', now, minAgeMs: 0 }).drop).not.toContain('am_production_not_a_test');
  });
});

describe('test:clean run isolation', () => {
  it('from run A leaves run B’s databases intact, and the helper prints the name the harness creates', async () => {
    const client = await maintenance();
    try {
      for (const name of [dbA, dbB]) {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await client.query(`CREATE DATABASE "${name}"`);
      }
      expect((await databaseNames()).sort()).toEqual([dbA, dbB].sort());

      // The shell side: the helper is authoritative, so its answer is what the CLI must protect.
      const printed = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/test/print-db.ts', 'am_test_clean'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, AM_TEST_RUN: runA, CI: '' },
      });
      expect(printed.status, printed.stderr).toBe(0);
      expect(printed.stdout.trim()).toBe(dbA);

      const cleaned = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/test/clean.ts'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          AM_TEST_RUN: runA,
          CI: '',
          TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? maintenanceUrl,
          CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
        },
      });
      expect(cleaned.status, cleaned.stderr + cleaned.stdout).toBe(0);
      expect(await databaseNames()).toEqual([dbB]);
      expect(cleaned.stdout).toContain(dbA);
    } finally {
      await client.end();
    }
  }, 30_000);
});

describe('cleaning a run directly', () => {
  it('does not drop a database created for another run', async () => {
    const client = await maintenance();
    try {
      for (const name of [dbA, dbB]) {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await client.query(`CREATE DATABASE "${name}"`);
      }
      const result = await cleanTestDatabases({ run: runA, clickhouseUrl: 'http://127.0.0.1:1' });
      expect(result.pgDropped).toContain(dbA);
      expect(result.pgDropped).not.toContain(dbB);
      expect(result.skipped).toContainEqual({ name: dbB, reason: 'belongs to another run' });
      expect(await databaseNames()).toEqual([dbB]);
    } finally {
      await client.end();
    }
  }, 30_000);

  it('reports ClickHouse databases it could not reach instead of failing the run', async () => {
    const result = await cleanTestDatabases({ run: runA, clickhouseUrl: 'http://127.0.0.1:1' });
    expect(result.skipped.some((entry) => /ClickHouse/.test(entry.reason))).toBe(true);
  }, 30_000);

  it('never force-drops another run: a stale database that gains a connection is skipped', async () => {
    const client = await maintenance();
    let held: pg.Client | null = null;
    try {
      await client.query(`DROP DATABASE IF EXISTS "${dbB}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${dbB}"`);
      // The other run reconnects between inspection and the drop: simulate it by holding a
      // connection; minAgeMs 0 makes the database look stale and idle-by-age.
      held = new pg.Client({ connectionString: testDatabaseUrl(dbB).toString() });
      await held.connect();
      const result = await cleanTestDatabases({ run: runA, allStale: true, minAgeMs: 0, clickhouseUrl: 'http://127.0.0.1:1' });
      expect(result.pgDropped).not.toContain(dbB);
      expect(result.skipped.some((entry) => entry.name === dbB)).toBe(true);
      // The other run's connection survives.
      expect((await held.query('select 1 as ok')).rows[0].ok).toBe(1);
    } finally {
      await held?.end();
      await client.query(`DROP DATABASE IF EXISTS "${dbB}" WITH (FORCE)`);
      await client.end();
    }
  }, 30_000);
});

describe('ClickHouse drop decisions (#515 review)', () => {
  const base = { allStale: true, inCurrentRun: false, pgDropped: true };
  it('skips another run when ClickHouse activity is unknown', () => {
    expect(clickHouseDropDecision({ ...base, active: null, name: 'x' })).toMatchObject({ drop: false });
  });
  it('skips another run with an active query, and drops an idle stale one', () => {
    expect(clickHouseDropDecision({ ...base, active: new Set(['x']), name: 'x' })).toMatchObject({ drop: false });
    expect(clickHouseDropDecision({ ...base, active: new Set(), name: 'x' })).toEqual({ drop: true });
  });
  it('always drops the current run, even when activity is unknown', () => {
    expect(clickHouseDropDecision({ ...base, inCurrentRun: true, active: null, name: 'x' })).toEqual({ drop: true });
  });
});
