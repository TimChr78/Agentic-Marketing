import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { parseRunDatabaseMarker } from '../../../packages/db/test/run';

// The migrated template database every test file copies, and the cleanup of run databases a killed
// run left behind. The template is shared by every checkout and delegate on the test stack, so it
// is built under one advisory lock (harness.ts takes it around the build).
//
// The template is named after a fingerprint of the whole recipe that shapes it: the migration SQL,
// the migrator and role setup, the auth options that generate Better Auth's tables, the installed
// Better Auth version and the app role. An unchanged tree reuses the completed template instead of
// replaying every migration; `COMMENT ON DATABASE` is the completeness marker, written last, so a
// build that crashed halfway is not mistaken for a finished one. Templates are never pruned
// automatically (`pnpm test:clean -- --templates` drops them by hand): a run may be cloning any of
// them, and clones happen outside the lock.

export const TEMPLATE_PREFIX = 'am_tpl_';

/** A `COMMENT ON DATABASE` value marking a template as complete for one fingerprint. */
export function templateMarker(fingerprint: string): string {
  return `am-test-template:${fingerprint}`;
}

/** The advisory lock key around template builds. */
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

export const TEST_STACK_MARKER_DB = 'am_test_stack';

/** How long a run database must be idle before the sweeper drops it. */
export const STALE_RUN_DATABASE_MS = 6 * 60 * 60 * 1000;

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/db/migrations');

/**
 * Source inputs whose behaviour shapes the template: the migrator and role setup, the whole auth
 * package source (`migrateAuth` → `authOptions` reads plugin modules such as `sso.ts`, which add
 * columns), and the lockfile, which pins every schema-producing dependency (Better Auth and its SSO,
 * MCP/OAuth and CIMD plugins). A directory entry stands for every file under it (#987 review).
 */
const RECIPE_FILES = ['packages/db/src/migrate.ts', 'packages/auth/src', 'pnpm-lock.yaml'];

/** Expands directory entries to the sorted list of files under them, relative to the repository root. */
export function recipeFiles(entries: readonly string[] = RECIPE_FILES): string[] {
  const out: string[] = [];
  const visit = (relative: string) => {
    const absolute = resolve(REPO_ROOT, relative);
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(relative, entry));
    } else out.push(relative);
  };
  for (const entry of entries) visit(entry);
  return out.sort();
}

/** Whether a database is a template, including the old run-scoped `am_<run>_test_template` names. */
export function isTemplateDatabase(name: string): boolean {
  return name.startsWith(TEMPLATE_PREFIX) || name.endsWith('_test_template');
}

/** The installed Better Auth version: it generates the auth tables `migrateAuth` writes. */
export function betterAuthVersion(from: string = join(REPO_ROOT, 'packages/auth/package.json')): string {
  const require = createRequire(from);
  let dir = dirname(require.resolve('better-auth'));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'better-auth' && pkg.version) return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not find the installed better-auth package.json');
    dir = parent;
  }
}

export interface TemplateFingerprintOptions {
  /** The directory of migration SQL files (tests point it at a fixture). */
  migrationsDir?: string;
  /** Recipe source files, resolved against the repository root. */
  files?: string[];
  /** Version inputs that shape the schema but are no repository file. */
  versions?: Record<string, string>;
  /** The migration role the template is built for. */
  /** Only the role name: grants in the template name it. Its password lives in the cluster-wide role, not the template. */
  role?: { appRole: string };
}

/**
 * A short fingerprint of everything the template build reads: every migration file, the migrator
 * and role setup, the auth options module, the installed Better Auth version and the app role.
 * Changing any input builds a new template; changing anything else does not.
 */
export function templateFingerprint(options: TemplateFingerprintOptions = {}): string {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const files = options.files ?? RECIPE_FILES;
  const versions = options.versions ?? { 'better-auth': betterAuthVersion() };
  const role = options.role ?? { appRole: '' };
  const hash = createHash('sha256');
  const add = (label: string, value: string) => hash.update(`${label}\0${value}\0`);

  for (const name of readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort())
    add(`migration:${name}`, readFileSync(join(migrationsDir, name), 'utf8'));
  for (const file of recipeFiles(files)) add(`file:${file}`, readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  for (const [name, version] of Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))) add(`version:${name}`, version);
  add('role:appRole', role.appRole);

  return hash.digest('hex').slice(0, 12);
}

/** The template database name for a fingerprint. */
export function templateDatabaseName(fingerprint: string): string {
  return `${TEMPLATE_PREFIX}${fingerprint}`;
}

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface DatabaseRow {
  name: string;
  /** The database's `COMMENT`, which is how a run says it owns it, or null. */
  marker: string | null;
  /** When PostgreSQL created the database's directory; null when the server cannot report it. */
  created: Date | null;
  active: number;
}

interface PgRow {
  name: string;
  oid: number;
  marker: string | null;
  active: number;
  created: Date | null;
}

/** Every non-template database with its comment, live connection count and creation time. */
export async function databaseRows(client: pg.Client): Promise<DatabaseRow[]> {
  const sql = (withAge: boolean) => `
    SELECT d.datname AS name,
           d.oid,
           shobj_description(d.oid, 'pg_database') AS marker,
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
  return rows.map((row) => ({
    name: row.name,
    marker: row.marker,
    active: row.active,
    created: row.created ? new Date(row.created) : null,
  }));
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

/** Whether the server is the shared test stack: only `scripts/test-services.sh up` creates the marker. */
export async function hasTestStackMarker(client: pg.Client, markerDatabase: string = TEST_STACK_MARKER_DB): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [markerDatabase]);
  return rows.length > 0;
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

/**
 * Run databases that are safe to drop: owned by a run through its `am-test-run:` comment, not the
 * calling run's own, idle, and older than the threshold. A database without that comment is never
 * a candidate, whatever its name; everything declined is reported.
 */
export function classifyRunDatabases(rows: DatabaseRow[], options: StaleRunOptions): StaleRunResult {
  const minAgeMs = options.minAgeMs ?? STALE_RUN_DATABASE_MS;
  const now = options.now ?? Date.now();
  const hours = Math.round(minAgeMs / 3_600_000);
  const result: StaleRunResult = { found: 0, drop: [], skipped: [] };
  for (const row of rows) {
    const marker = parseRunDatabaseMarker(row.marker);
    if (!marker) continue;
    result.found++;
    if (marker.run === options.run) {
      result.skipped.push({ name: row.name, reason: "this run's own database" });
    } else if (row.active > 0) {
      result.skipped.push({ name: row.name, reason: `${row.active} active connection(s)` });
    } else if (now - marker.created < minAgeMs) {
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

export interface SweepResult extends StaleRunResult {
  /** False when the server is not the shared test stack (fail closed) or could not be checked. */
  swept: boolean;
  reason?: string;
  /** The databases actually dropped (some candidates may fail to drop). */
  dropped: string[];
}

/**
 * Drops the run databases of killed runs (see classifyRunDatabases), but only on the shared test
 * stack: a Postgres without the marker database is left untouched and nothing is dropped. The caller
 * holds TEMPLATE_LOCK. A database that cannot be dropped is reported, never an error.
 */
export async function sweepRunDatabases(client: pg.Client, options: StaleRunOptions & { markerDatabase?: string }): Promise<SweepResult> {
  if (!(await hasTestStackMarker(client, options.markerDatabase))) {
    return {
      swept: false,
      reason: `no ${options.markerDatabase ?? TEST_STACK_MARKER_DB} database: not the shared test stack`,
      found: 0,
      drop: [],
      dropped: [],
      skipped: [],
    };
  }
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
  return { swept: true, found: result.found, drop: result.drop, dropped, skipped };
}
