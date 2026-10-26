import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, createReadStream, createWriteStream, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureAppRoleInDatabase, latestMigration, migrationHead } from '@agentic-marketing/db';

// Backup and restore without loading the full server configuration: an operator must be able to
// run them with only DATABASE_URL (and CLICKHOUSE_URL for events), even when other secrets are
// missing. Everything here reads the few environment variables it needs directly.

export interface FileEntry {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ClickHouseTableEntry extends FileEntry {
  name: string;
  rows: number;
}

export interface BackupManifest {
  format: 1;
  version: string;
  migrationHead: string | null;
  createdAt: string;
  postgres: FileEntry;
  clickhouse?: { tables: ClickHouseTableEntry[] };
}

export interface CreateBackupOptions {
  /** Overrides BACKUP_DIR; relative paths resolve under INIT_CWD. */
  dir?: string;
  databaseUrl?: string;
  clickhouse?: boolean;
  keepDays?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface RestoreBackupOptions {
  dir: string;
  force?: boolean;
  clickhouse?: boolean;
  databaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** Absolute path under the invoking directory (`INIT_CWD`), as pnpm reports it. */
export function resolveUserPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}

/**
 * BACKUP_DIR, else /backups when it exists and is writable (the image mounts a named volume
 * there), else ./backups under INIT_CWD for development.
 */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BACKUP_DIR?.trim()) return resolveUserPath(env.BACKUP_DIR, env);
  try {
    if (statSync('/backups').isDirectory()) {
      accessSync('/backups', fsConstants.W_OK);
      return '/backups';
    }
  } catch {
    // Not mounted or not writable: fall through to the working directory.
  }
  return resolveUserPath('backups', env);
}

export function parseKeepDays(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) throw new Error('BACKUP_KEEP_DAYS/--keep-days must be a positive whole number of days');
  return days;
}

export function keepDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseKeepDays(env.BACKUP_KEEP_DAYS);
}

/** The version of this build; the image has apps/server/package.json next to the running source. */
export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('apps/server/package.json has no version');
  return pkg.version;
}

/** Postgres client environment from a URL, so a password never appears in argv or a log line. */
export function postgresClientEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('DATABASE_URL must be a postgres:// URL');
  const env: NodeJS.ProcessEnv = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) fail(err);
      else done();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT')
        finish(
          new Error(`${command} was not found. Install the PostgreSQL 16 client tools (postgresql-client-16 in the image) and try again.`),
        );
      else finish(err);
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} failed (exit ${code}): ${stderr.trim() || 'no error output'}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function fileEntry(root: string, file: string): Promise<FileEntry> {
  const path = join(root, file);
  const info = await stat(path);
  return { file, bytes: info.size, sha256: await sha256File(path) };
}

/** Runs pg_dump -Fc --no-owner; connection details travel through PG* variables. */
export async function dumpPostgres(databaseUrl: string, outFile: string): Promise<void> {
  await run('pg_dump', ['-Fc', '--no-owner', '--file', outFile], postgresClientEnv(databaseUrl));
}

/** Runs pg_restore --clean --if-exists --no-owner against DATABASE_URL. */
export async function restorePostgres(databaseUrl: string, dumpFile: string): Promise<void> {
  const clientEnv = postgresClientEnv(databaseUrl);
  if (!clientEnv.PGDATABASE) throw new Error('DATABASE_URL has no database name');
  // The database name is safe in argv; the password stays in PGPASSWORD.
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', clientEnv.PGDATABASE, dumpFile], clientEnv);
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<{ dir: string; manifest: BackupManifest }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const databaseUrl = opts.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const dir = opts.dir ? resolveUserPath(opts.dir, env) : resolveBackupDir(env);
  const keepDays = opts.keepDays ?? keepDaysFromEnv(env);
  const version = readVersion();
  const createdAt = new Date();
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const name = `am-${version}-${stamp}`;
  const finalDir = join(dir, name);
  // A partial backup must never look like a completed one: write under a dot-prefixed name and
  // rename only after the manifest exists.
  const tempDir = join(dir, `.${name}.partial`);

  await mkdir(dir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  try {
    log(`dumping Postgres to ${join(name, 'postgres.dump')}`);
    await dumpPostgres(databaseUrl, join(tempDir, 'postgres.dump'));
    const manifest: BackupManifest = {
      format: 1,
      version,
      migrationHead: await migrationHead(databaseUrl),
      createdAt: createdAt.toISOString(),
      postgres: await fileEntry(tempDir, 'postgres.dump'),
    };

    if (opts.clickhouse) {
      log('exporting ClickHouse tables');
      manifest.clickhouse = { tables: await exportClickHouse({ env, outDir: tempDir, log }) };
    }

    await writeFile(join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(tempDir, finalDir);
    log(`backup written to ${finalDir}`);
    if (keepDays !== undefined) {
      try {
        await pruneBackups(dir, keepDays, log);
      } catch (err) {
        // The backup itself is complete; failing to remove an old one should not report failure.
        log(`could not prune old backups: ${(err as Error).message}`);
      }
    }
    return { dir: finalDir, manifest };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Deletes only completed `am-*` backups older than the retention window. */
export async function pruneBackups(dir: string, keepDays: number, log: (message: string) => void = () => {}): Promise<string[]> {
  const cutoff = Date.now() - keepDays * 86_400_000;
  const removed: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('am-')) continue;
    const path = join(dir, entry.name);
    try {
      await stat(join(path, 'manifest.json'));
      if ((await stat(path)).mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed.push(path);
        log(`removed old backup ${path}`);
      }
    } catch {
      // Not a completed backup (no manifest): never delete it.
    }
  }
  return removed;
}

function assertIdentifier(value: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid ${what} name ${value}`);
  return value;
}

const quoteIdentifier = (value: string) => `\`${assertIdentifier(value, 'ClickHouse')}\``;

function clickhouseEndpoint(raw: string | undefined): { url: URL; headers: Record<string, string> } {
  const url = new URL(raw?.trim() || 'http://localhost:8123');
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return { url, headers };
}

async function clickhouseRequest(
  endpoint: { url: URL; headers: Record<string, string> },
  database: string,
  query: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(endpoint.url);
  target.searchParams.set('query', query);
  target.searchParams.set('database', database);
  const headers = new Headers(endpoint.headers);
  if (init.headers) for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  const response = await fetch(target, { ...init, headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000).trim();
    throw new Error(`ClickHouse request failed (${response.status}): ${detail || response.statusText}`);
  }
  return response;
}

/** Streams every MergeTree-family table as Native; views and materialized views are skipped. */
export async function exportClickHouse(opts: {
  env?: NodeJS.ProcessEnv;
  outDir: string;
  url?: string;
  database?: string;
  log?: (message: string) => void;
}): Promise<ClickHouseTableEntry[]> {
  const env = opts.env ?? process.env;
  const database = assertIdentifier(opts.database ?? (env.CLICKHOUSE_DATABASE?.trim() || 'am'), 'ClickHouse database');
  const endpoint = clickhouseEndpoint(opts.url ?? env.CLICKHOUSE_URL);
  const list = await clickhouseRequest(
    endpoint,
    database,
    "SELECT name, engine, total_rows FROM system.tables WHERE database = currentDatabase() AND engine LIKE '%MergeTree%' ORDER BY name FORMAT JSONEachRow",
    { method: 'GET' },
  );
  const tables = (await list.text())
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { name: string; total_rows: string | number });

  await mkdir(join(opts.outDir, 'clickhouse'), { recursive: true });
  const result: ClickHouseTableEntry[] = [];
  for (const table of tables) {
    const name = assertIdentifier(table.name, 'ClickHouse table');
    const file = `clickhouse/${name}.native`;
    const response = await clickhouseRequest(
      endpoint,
      database,
      `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(name)} FORMAT Native`,
      { method: 'GET' },
    );
    if (!response.body) throw new Error(`ClickHouse returned no data for ${database}.${name}`);
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      createWriteStream(join(opts.outDir, file)),
    );
    const entry = await fileEntry(opts.outDir, file);
    result.push({ name, rows: Number(table.total_rows) || 0, ...entry });
    opts.log?.(`exported ClickHouse ${database}.${name} (${entry.bytes} bytes)`);
  }
  return result;
}

/** Replaces each table's contents with the Native file from a backup. */
export async function restoreClickHouse(opts: {
  runDir: string;
  tables: ClickHouseTableEntry[];
  env?: NodeJS.ProcessEnv;
  url?: string;
  database?: string;
  log?: (message: string) => void;
}): Promise<void> {
  const env = opts.env ?? process.env;
  const database = assertIdentifier(opts.database ?? (env.CLICKHOUSE_DATABASE?.trim() || 'am'), 'ClickHouse database');
  const endpoint = clickhouseEndpoint(opts.url ?? env.CLICKHOUSE_URL);
  for (const table of opts.tables) {
    const name = assertIdentifier(table.name, 'ClickHouse table');
    const path = resolve(opts.runDir, table.file);
    if (!path.startsWith(resolve(opts.runDir) + sep)) throw new Error(`manifest path escapes the backup: ${table.file}`);
    opts.log?.(`restoring ClickHouse ${database}.${name}`);
    await clickhouseRequest(endpoint, database, `TRUNCATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(name)}`, { method: 'POST' });
    await clickhouseRequest(endpoint, database, `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(name)} FORMAT Native`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
  }
}

function manifestPath(dir: string, file: string): string {
  const path = resolve(dir, file);
  if (path !== resolve(dir) && !path.startsWith(resolve(dir) + sep)) throw new Error(`manifest path escapes the backup: ${file}`);
  return path;
}

function isFileEntry(value: unknown): value is FileEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.file === 'string' && typeof v.bytes === 'number' && typeof v.sha256 === 'string';
}

/** Reads and structurally checks manifest.json (checksums are verified separately). */
export async function readManifest(dir: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Partial<BackupManifest>;
  if (manifest.format !== 1) throw new Error(`unsupported backup format ${String(manifest.format)}; this version reads format 1`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('manifest.json has no version');
  if (typeof manifest.createdAt !== 'string' || !manifest.createdAt) throw new Error('manifest.json has no createdAt');
  if (manifest.migrationHead !== null && typeof manifest.migrationHead !== 'string')
    throw new Error('manifest.json has an invalid migrationHead');
  if (!isFileEntry(manifest.postgres)) throw new Error('manifest.json has no valid postgres entry');
  if (manifest.clickhouse !== undefined) {
    if (!manifest.clickhouse || !Array.isArray(manifest.clickhouse.tables))
      throw new Error('manifest.json has an invalid clickhouse entry');
    for (const table of manifest.clickhouse.tables) {
      if (!isFileEntry(table) || typeof table.name !== 'string' || typeof table.rows !== 'number')
        throw new Error('manifest.json has an invalid ClickHouse table entry');
    }
  }
  return manifest as BackupManifest;
}

async function verifyEntry(root: string, entry: FileEntry): Promise<void> {
  const path = manifestPath(root, entry.file);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`backup file is missing: ${entry.file}`);
  }
  if (info.size !== entry.bytes) throw new Error(`${entry.file} is ${info.size} bytes, the manifest says ${entry.bytes}`);
  const actual = await sha256File(path);
  if (actual !== entry.sha256) throw new Error(`${entry.file} does not match its sha256 (expected ${entry.sha256}, got ${actual})`);
}

/**
 * Verifies a backup, refuses a newer schema unless forced, then replaces Postgres (and optionally
 * ClickHouse). It does not stop the app: the caller warns the operator to do that first.
 */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<BackupManifest> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const dir = resolveUserPath(opts.dir, env);
  const manifest = await readManifest(dir);
  log(`verifying backup ${dir}`);
  await verifyEntry(dir, manifest.postgres);

  const newest = latestMigration();
  if (!opts.force && manifest.migrationHead && newest && manifest.migrationHead > newest)
    throw new Error(
      `the backup has migration ${manifest.migrationHead}, but this version only knows up to ${newest}. ` +
        'Upgrade the image first, or pass --force to restore anyway.',
    );

  if (opts.clickhouse) {
    if (!manifest.clickhouse) throw new Error('this backup has no ClickHouse tables; take a backup with --clickhouse first');
    for (const table of manifest.clickhouse.tables) await verifyEntry(dir, table);
  }

  const databaseUrl = opts.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  // migrate() recreates the role on every start, but it does not re-run the GRANTs from applied
  // migrations. The dump keeps ACLs, so the grants come back with pg_restore; the role must exist
  // before those GRANT statements run. Reuse the same role helper as migrate().
  const role = await ensureAppRoleInDatabase(databaseUrl, {
    appRole: env.APP_DB_ROLE?.trim() || 'am_app',
    appRolePassword: env.APP_DB_PASSWORD,
  });
  if (!role.exists) throw new Error(`Postgres role ${role.role} does not exist; set APP_DB_PASSWORD so the restore can create it`);

  log('restoring Postgres (this replaces the current database)');
  await restorePostgres(databaseUrl, manifestPath(dir, manifest.postgres.file));

  if (opts.clickhouse && manifest.clickhouse) {
    log('restoring ClickHouse');
    await restoreClickHouse({ runDir: dir, tables: manifest.clickhouse.tables, env, log });
  }
  log('restore complete; start the app again (it applies any migrations this version still needs)');
  return manifest;
}

// A small standard 5-field cron matcher, UTC only. It deliberately supports just the syntax the
// backup service documents (*, numbers, lists, ranges and steps) and no dependencies.
export interface CronSpec {
  expression: string;
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const CRON_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseCronField(field: string, min: number, max: number, isDayOfWeek: boolean): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    // Only `*`, `N`, `N-M` and an optional `/step`; this rejects things like `1-2-3` or `-5`
    // that Number() would otherwise turn into surprising ranges.
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`invalid item "${part}" in cron field "${field}"`);
    const range = match[1];
    const stepText = match[2];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${stepText}" in cron field "${field}"`);

    let start: number;
    let end: number;
    if (range === '*') {
      [start, end] = [min, max];
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(range);
      end = stepText === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end)
      throw new Error(`invalid value "${range}" in cron field "${field}" (expected ${min}-${max})`);

    for (let value = start; value <= end; value += step) values.add(isDayOfWeek && value === 7 ? 0 : value);
  }
  if (!values.size) throw new Error(`cron field "${field}" matches nothing`);
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error(`BACKUP_CRON must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  return {
    expression: expression.trim(),
    minute: parseCronField(fields[0], ...CRON_RANGES[0], false),
    hour: parseCronField(fields[1], ...CRON_RANGES[1], false),
    dayOfMonth: parseCronField(fields[2], ...CRON_RANGES[2], false),
    month: parseCronField(fields[3], ...CRON_RANGES[3], false),
    dayOfWeek: parseCronField(fields[4], ...CRON_RANGES[4], true),
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  };
}

/** Standard cron semantics: when both day fields are restricted, either one may match. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  const dayOfMonth = spec.dayOfMonth.includes(at.getUTCDate());
  const dayOfWeek = spec.dayOfWeek.includes(at.getUTCDay());
  const day = spec.dayOfMonthRestricted && spec.dayOfWeekRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
  return (
    spec.minute.includes(at.getUTCMinutes()) && spec.hour.includes(at.getUTCHours()) && spec.month.includes(at.getUTCMonth() + 1) && day
  );
}

function sleepUntilNextMinute(signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const next = Math.floor(now / 60_000) * 60_000 + 60_000;
  const delay = Math.max(250, next - now + 50);
  return new Promise((resolveSleep) => {
    if (signal.aborted) return resolveSleep();
    const timer = setTimeout(done, delay);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `am backup --schedule`: checks the cron expression every minute and keeps going on failure. */
export async function runScheduledBackups(
  opts: { clickhouse?: boolean; env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  if (!env.DATABASE_URL) {
    log('DATABASE_URL is not set');
    return 1;
  }
  const expression = env.BACKUP_CRON?.trim() || '30 3 * * *';
  let spec: CronSpec;
  try {
    spec = parseCron(expression);
  } catch (err) {
    log(`invalid BACKUP_CRON: ${(err as Error).message}`);
    return 1;
  }
  let keepDays: number;
  try {
    keepDays = parseKeepDays(env.BACKUP_KEEP_DAYS) ?? 14;
  } catch (err) {
    log(`invalid BACKUP_KEEP_DAYS: ${(err as Error).message}`);
    return 1;
  }
  log(`scheduled backups: ${expression} (UTC), keeping ${keepDays} days`);

  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  let lastRunMinute = '';
  try {
    while (!stop.signal.aborted) {
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      if (minute !== lastRunMinute && cronMatches(spec, now)) {
        lastRunMinute = minute;
        try {
          // createBackup logs the final path; a failure is not fatal for the scheduler.
          await createBackup({ clickhouse: opts.clickhouse, keepDays, env, log });
        } catch (err) {
          log(`backup failed: ${(err as Error).message}`);
        }
      }
      await sleepUntilNextMinute(stop.signal);
    }
  } finally {
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  }
  log('scheduled backups stopped');
  return 0;
}
