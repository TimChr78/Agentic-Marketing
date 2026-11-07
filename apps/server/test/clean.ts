import { pathToFileURL } from 'node:url';
import { resetClickHouse } from '@agentic-marketing/events';
import pg from 'pg';
import { runId, sanitiseRunId } from '../../../packages/db/test/run';
import { testDatabaseUrl } from './harness';

// `pnpm test:clean`: drops the databases a crashed test run left behind (#173). A run's global
// teardown removes its own prefix; this removes leftovers on the TEST_DATABASE_URL Postgres
// server and the CLICKHOUSE_URL server.
//
// By default it only touches the current run's namespace (`am_<AM_TEST_RUN>_...`). That namespace
// is the one the harness creates, so two checkouts sharing a stack never delete each other's
// databases. `--all-stale` opts into older runs that are demonstrably idle, and reports every
// database it declines to drop.

const TEST_DB_BODY = '(?:test_|e2e|backup_|doctor_)';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names in the current run's namespace: `am_<run>_test_*`, `am_<run>_e2e`, ... */
export function currentRunPattern(run: string): RegExp {
  return run ? new RegExp(`^am_${escapeRegExp(run)}_${TEST_DB_BODY}`) : new RegExp(`^am_${TEST_DB_BODY}`);
}

/** Any namespace's test database, with or without a run segment. */
export const anyTestDbPattern = () => new RegExp(`^am_(?:[a-z0-9]+_)?${TEST_DB_BODY}`);

export interface DbRow {
  name: string;
  active: number;
  /** When PostgreSQL created the database's directory; null when the server cannot report it. */
  created: Date | null;
}

export interface StaleOptions {
  run: string;
  now?: number;
  minAgeMs: number;
}

export interface CleanSkip {
  name: string;
  reason: string;
}

export interface CleanResult {
  run: string;
  pgDropped: string[];
  chDropped: string[];
  skipped: CleanSkip[];
}

/**
 * Picks the other-run databases that are safe to drop: idle (no `pg_stat_activity` connection),
 * older than the threshold, and unambiguously test databases. Everything else is reported.
 */
export function classifyStale(rows: DbRow[], opts: StaleOptions): { drop: string[]; skipped: CleanSkip[] } {
  const current = currentRunPattern(opts.run);
  const any = anyTestDbPattern();
  const now = opts.now ?? Date.now();
  const minutes = Math.round(opts.minAgeMs / 60_000);
  const drop: string[] = [];
  const skipped: CleanSkip[] = [];
  for (const row of rows) {
    if (!any.test(row.name)) continue;
    if (current.test(row.name)) {
      skipped.push({ name: row.name, reason: 'belongs to the current run' });
    } else if (row.active > 0) {
      skipped.push({ name: row.name, reason: `${row.active} active connection(s)` });
    } else if (!row.created) {
      skipped.push({ name: row.name, reason: 'age unknown' });
    } else if (now - row.created.getTime() < opts.minAgeMs) {
      skipped.push({ name: row.name, reason: `younger than ${minutes} minute(s)` });
    } else {
      drop.push(row.name);
    }
  }
  return { drop, skipped };
}

interface PgRow extends DbRow {
  oid: number;
}

/** Lists databases with their live connection count and creation time (when the server can say). */
async function databaseRows(client: pg.Client): Promise<PgRow[]> {
  const sql = (withAge: boolean) => `
    SELECT d.datname AS name,
           d.oid,
           (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS active
           ${withAge ? ", (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification AS created" : ', NULL::timestamptz AS created'}
    FROM pg_database d
    WHERE NOT d.datistemplate`;
  try {
    const { rows } = await client.query<PgRow>(sql(true));
    return rows;
  } catch {
    // pg_stat_file needs privileges a restricted test role may not have; age stays unknown and
    // --all-stale declines to guess.
    const { rows } = await client.query<PgRow>(sql(false));
    return rows;
  }
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function dropDatabase(client: pg.Client, name: string) {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

async function clickHouseDatabases(url: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${url}/?query=${encodeURIComponent('SHOW DATABASES')}`);
    if (!response.ok) return null;
    return (await response.text())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function clickHouseActiveDatabases(url: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${url}/?query=${encodeURIComponent('SELECT DISTINCT database FROM system.processes')}`);
    if (!response.ok) return null;
    return new Set(
      (await response.text())
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export interface CleanOptions {
  /** The run namespace to clean; defaults to AM_TEST_RUN (or the harness derivation). */
  run?: string;
  /** Drop other runs that are idle and older than [minAgeMs]. */
  allStale?: boolean;
  minAgeMs?: number;
  /** Injectable for tests. */
  now?: number;
  clickhouseUrl?: string;
}

/**
 * Cleans one run's namespace. Returns what it dropped and what it declined to drop, so the CLI can
 * print an honest report.
 */
export async function cleanTestDatabases(opts: CleanOptions = {}): Promise<CleanResult> {
  const run = sanitiseRunId(opts.run ?? runId);
  const current = currentRunPattern(run);
  const chUrl = opts.clickhouseUrl ?? process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  const result: CleanResult = { run, pgDropped: [], chDropped: [], skipped: [] };

  const client = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await client.connect();
  let rows: PgRow[];
  try {
    rows = await databaseRows(client);
    const currentRows = rows.filter((row) => current.test(row.name)).map((row) => row.name);
    const stale = opts.allStale
      ? classifyStale(rows, { run, now: opts.now, minAgeMs: opts.minAgeMs ?? 60 * 60_000 })
      : { drop: [] as string[], skipped: [] as CleanSkip[] };

    if (!opts.allStale) {
      // Still report other runs, so an operator can see exactly what this invocation protected.
      for (const row of rows) {
        if (anyTestDbPattern().test(row.name) && !current.test(row.name)) {
          result.skipped.push({ name: row.name, reason: 'belongs to another run' });
        }
      }
    } else {
      result.skipped.push(...stale.skipped.filter((entry) => !current.test(entry.name)));
    }

    for (const name of [...currentRows, ...stale.drop]) {
      await dropDatabase(client, name);
      result.pgDropped.push(name);
    }
  } finally {
    await client.end();
  }

  const chNames = await clickHouseDatabases(chUrl);
  const chActive = await clickHouseActiveDatabases(chUrl);
  if (!chNames) {
    result.skipped.push({ name: 'ClickHouse', reason: 'ClickHouse unavailable; no databases were dropped there' });
  } else {
    for (const name of chNames) {
      const inCurrentRun = current.test(name);
      if (!inCurrentRun && !opts.allStale) {
        if (anyTestDbPattern().test(name)) result.skipped.push({ name, reason: 'belongs to another run' });
        continue;
      }
      if (!inCurrentRun) {
        if (!result.pgDropped.includes(name)) {
          result.skipped.push({ name, reason: 'no matching Postgres database met the stale threshold' });
          continue;
        }
        if (chActive?.has(name)) {
          result.skipped.push({ name, reason: 'has an active ClickHouse query' });
          continue;
        }
      }
      try {
        await resetClickHouse(chUrl, name);
        result.chDropped.push(name);
      } catch (error) {
        result.skipped.push({ name, reason: `ClickHouse drop failed: ${(error as Error).message}` });
      }
    }
  }
  return result;
}

function report(result: CleanResult) {
  const namespace = result.run ? `run ${result.run}` : 'the namespace-less CI run';
  console.log(
    `Cleaned ${namespace}: dropped ${result.pgDropped.length} Postgres and ${result.chDropped.length} ClickHouse test databases.`,
  );
  for (const name of result.pgDropped) console.log(`  dropped ${name}`);
  for (const name of result.chDropped) console.log(`  dropped ClickHouse ${name}`);
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} database(s):`);
    for (const entry of result.skipped) console.log(`  ${entry.name}: ${entry.reason}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--all-stale');
  if (unknown.length > 0) {
    console.error(`error: unknown argument '${unknown[0]}' (usage: test:clean [--all-stale])`);
    process.exit(2);
  }
  const allStale = args.includes('--all-stale');
  const minutes = Number(process.env.AM_TEST_CLEAN_STALE_MINUTES ?? 60);
  if (!process.env.AM_TEST_RUN && !process.env.CI) {
    console.warn(
      `note: AM_TEST_RUN is not set; using the derived run namespace '${runId}'. Set AM_TEST_RUN to the crashed run's namespace to clean that run.`,
    );
  }
  const result = await cleanTestDatabases({
    run: runId,
    allStale,
    minAgeMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000,
  });
  report(result);
}
