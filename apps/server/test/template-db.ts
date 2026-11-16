import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// The migrated template database every test file copies, and the cleanup of run databases a killed
// run left behind. Both are shared by every checkout and delegate on the test stack, so both run
// under one advisory lock (harness.ts takes it around them).
//
// The template is named after a fingerprint of the migration files: a migration edit produces a new
// template, and an unchanged tree reuses the one it built last time instead of replaying every
// migration on each run. `COMMENT ON DATABASE` is the completeness marker, written last, so a build
// that crashed halfway is not mistaken for a finished one. The newest few templates are kept, so a
// branch that switches between two heads does not rebuild on every switch.

export const TEMPLATE_PREFIX = 'am_tpl_';

/** A `COMMENT ON DATABASE` value marking a template as complete for one fingerprint. */
export function templateMarker(fingerprint: string): string {
  return `am-test-template:${fingerprint}`;
}

/** The advisory lock key shared by template builds, template drops and stale-run sweeps. */
export const TEMPLATE_LOCK = 'am_test_template_maintenance';

/**
 * Runs `fn` under the stack-wide template maintenance lock. It is a session advisory lock, so two
 * concurrent runs (or two calls in one process, each on its own connection) serialise here.
 */
export async function withTemplateLock<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [TEMPLATE_LOCK]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [TEMPLATE_LOCK]);
  }
}

/** How long a run database must be idle before the sweeper drops it. */
export const STALE_RUN_DATABASE_MS = 6 * 60 * 60 * 1000;

/** How many templates to keep (the newest by creation time; the others are dropped). */
export const KEEP_TEMPLATES = 3;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

/**
 * A short fingerprint of every migration file: sorted file names and their contents. A migration
 * edit, add or removal changes it; any other repository change does not.
 */
export function migrationsFingerprint(dir: string = MIGRATIONS_DIR): string {
  const hash = createHash('sha256');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** The template database name for a fingerprint (default: the migrations on disk). */
export function templateDatabaseName(fingerprint: string = migrationsFingerprint()): string {
  return `${TEMPLATE_PREFIX}${fingerprint}`;
}

/** Whether a database is a template, old naming (`am_<run>_test_template`) included. */
export function isTemplateDatabase(name: string): boolean {
  return name.startsWith(TEMPLATE_PREFIX) || name.endsWith('_test_template');
}

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface DatabaseRow {
  name: string;
  /** When PostgreSQL created the database's directory; null when the server cannot report it. */
  created: Date | null;
  active: number;
}

interface PgRow {
  name: string;
  oid: number;
  active: number;
  created: Date | null;
}

/**
 * Every non-template database with its live connection count and creation time. `pg_stat_file` is
 * what tells us how old a database is; a restricted role may not read it, and then age is unknown
 * and the callers decline to guess.
 */
export async function databaseRows(client: pg.Client): Promise<DatabaseRow[]> {
  const sql = (withAge: boolean) => `
    SELECT d.datname AS name,
           d.oid,
           (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS active
           ${withAge ? ", (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification AS created" : ', NULL::timestamptz AS created'}
    FROM pg_database d
    WHERE NOT d.datistemplate`;
  let rows: PgRow[];
  try {
    rows = (await client.query<PgRow>(sql(true))).rows;
  } catch {
    rows = (await client.query<PgRow>(sql(false))).rows;
  }
  return rows.map((row) => ({ name: row.name, active: row.active, created: row.created ? new Date(row.created) : null }));
}

/**
 * Creates a template database and marks it complete, unless a complete one with the same name
 * already exists. `build` runs the migrations. The caller holds TEMPLATE_LOCK, so two runs never
 * build or drop the same template at once; the second one sees the marker and reuses it.
 */
export async function ensureTemplateDatabase(
  client: pg.Client,
  options: { name: string; marker: string; build: (name: string) => Promise<void> },
): Promise<{ built: boolean }> {
  const existing = await client.query<{ marker: string | null }>(
    `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
    [options.name],
  );
  if (existing.rows[0]?.marker === options.marker) return { built: false };

  // Missing, or a build that stopped before the marker: replace it. FORCE because an interrupted
  // build can leave its own sessions behind.
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(options.name)} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${quoteIdent(options.name)}`);
  await options.build(options.name);
  // Written last: a template without this comment is never reused. COMMENT takes a literal, not a
  // bind parameter; the marker is generated from a hash, so quoting is all it needs.
  await client.query(`COMMENT ON DATABASE ${quoteIdent(options.name)} IS '${options.marker.replaceAll("'", "''")}'`);
  return { built: true };
}

/**
 * Templates to drop: everything but the newest `keep`, and never one that still has a connection
 * (another run may be cloning it) or whose age is unknown.
 */
export function templatesToDrop(rows: DatabaseRow[], keep: number = KEEP_TEMPLATES): string[] {
  const templates = rows.filter((row) => isTemplateDatabase(row.name) && row.created !== null);
  const newestFirst = [...templates].sort((a, b) => b.created!.getTime() - a.created!.getTime());
  return newestFirst
    .slice(keep)
    .filter((row) => row.active === 0)
    .map((row) => row.name);
}

export interface StaleRunOptions {
  /** The run id of the calling run; its own databases are never candidates. */
  run: string;
  minAgeMs?: number;
  now?: number;
}

export interface StaleRunResult {
  found: number;
  drop: string[];
  skipped: { name: string; reason: string }[];
}

/** `am_<run>_<test name>`: the run namespace the harness writes, plus the e2e/backup/doctor names. */
export const RUN_DATABASE = /^am_([a-z0-9]{1,16})_/;

/**
 * Run databases that are safe to drop: matching the run naming convention, not a template, not the
 * calling run's own, idle, and older than the threshold. Everything else is reported.
 */
export function classifyRunDatabases(rows: DatabaseRow[], options: StaleRunOptions): StaleRunResult {
  const minAgeMs = options.minAgeMs ?? STALE_RUN_DATABASE_MS;
  const now = options.now ?? Date.now();
  const hours = Math.round(minAgeMs / 3_600_000);
  const own = options.run ? `am_${options.run}_` : null;
  const result: StaleRunResult = { found: 0, drop: [], skipped: [] };
  for (const row of rows) {
    const match = RUN_DATABASE.exec(row.name);
    if (!match || isTemplateDatabase(row.name)) continue;
    result.found++;
    if (own && row.name.startsWith(own)) {
      result.skipped.push({ name: row.name, reason: "this run's own database" });
    } else if (row.active > 0) {
      result.skipped.push({ name: row.name, reason: `${row.active} active connection(s)` });
    } else if (!row.created) {
      result.skipped.push({ name: row.name, reason: 'age unknown' });
    } else if (now - row.created.getTime() < minAgeMs) {
      result.skipped.push({ name: row.name, reason: `younger than ${hours} hour(s)` });
    } else {
      result.drop.push(row.name);
    }
  }
  return result;
}

/** Drops a stale database without FORCE: a run that reconnected makes the drop fail, not vanish. */
export async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

/**
 * Drops the run databases of killed runs (see classifyRunDatabases). The caller holds TEMPLATE_LOCK
 * and skips its own run's databases. A database that cannot be dropped is reported, never an error.
 */
export async function sweepRunDatabases(
  client: pg.Client,
  options: StaleRunOptions,
): Promise<{ found: number; dropped: string[]; skipped: { name: string; reason: string }[] }> {
  const result = classifyRunDatabases(await databaseRows(client), options);
  const dropped: string[] = [];
  const skipped = [...result.skipped];
  for (const name of result.drop) {
    try {
      await dropDatabase(client, name);
      dropped.push(name);
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message });
    }
  }
  return { found: result.found, dropped, skipped };
}

/** Drops all but the newest templates. A drop that fails is reported, never fatal. */
export async function pruneTemplateDatabases(
  client: pg.Client,
  options: { keep?: number } = {},
): Promise<{ dropped: string[]; skipped: { name: string; reason: string }[] }> {
  const dropped: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of templatesToDrop(await databaseRows(client), options.keep)) {
    try {
      await dropDatabase(client, name);
      dropped.push(name);
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message });
    }
  }
  return { dropped, skipped };
}
