import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// The migrated template database every test file copies. It is shared by every checkout and
// delegate on the test stack, so it is built and dropped under one advisory lock (harness.ts takes
// it around the work).
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

/** The advisory lock key shared by template builds and drops. */
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
    hash.update(name).update('\0').update(readFileSync(join(dir, name))).update('\0');
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

/** Drops a stale database without FORCE: a run that reconnected makes the drop fail, not vanish. */
export async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
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
