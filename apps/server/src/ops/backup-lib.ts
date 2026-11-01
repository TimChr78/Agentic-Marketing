import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { accessSync, createReadStream, createWriteStream, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ensureAppRoleInDatabase,
  lastServerVersion,
  latestMigration,
  listWorkspaceIds,
  migrationHead,
  readDataKeySample,
  readErasureLog,
  replayErasures,
} from '@agentic-marketing/db';
import { keyProviderFromEnv } from '../keys';

// Backup and restore without loading the full server configuration: an operator must be able to
// run them with only DATABASE_URL (and CLICKHOUSE_URL for events), even when other secrets are
// missing. Everything here reads the few environment variables it needs directly.

export type BackupKind = 'pre-upgrade' | 'manual' | 'scheduled';

export interface FileEntry {
  file: string;
  bytes: number;
  sha256: string;
}

/** One exported ClickHouse file: a whole table, or one workspace's rows when it has a row policy. */
export interface ClickHouseFileEntry extends FileEntry {
  workspace?: string;
  rows: number;
}

export interface ClickHouseTableEntry {
  name: string;
  /** `system.tables.total_rows` read just before the export; the comparison that catches lost rows. */
  totalRowsBefore: number;
  files: ClickHouseFileEntry[];
}

/** 0.2.4's shape. Read for Postgres-only restores; its ClickHouse part is refused (see restoreBackup). */
export interface BackupManifestV1 {
  format: 1;
  version: string;
  migrationHead: string | null;
  createdAt: string;
  postgres: FileEntry;
  clickhouse?: { tables: (FileEntry & { name: string; rows: number })[] };
}

/**
 * Which key-encryption key (KEK) sealed the data keys in this backup, and a sealed constant that
 * proves the configured key can still unseal them. Neither field is key material: `reference` is
 * the provider's public id (`local-<sha256 prefix>`, `openbao:mount/key`, `aws-kms:key-id`) and
 * `check.wrapped` is a ciphertext.
 */
export interface BackupKeyInfo {
  reference: string;
  check?: { kekId: string; wrapped: string };
}

export interface BackupManifest {
  format: 2;
  kind: BackupKind;
  /** The build that wrote this backup. */
  version: string;
  /** The version the backed-up data was last running, or null when it cannot be known. */
  fromVersion: string | null;
  /** Only for a pre-upgrade backup: the build that was about to migrate the database. */
  toVersion?: string;
  migrationHead: string | null;
  createdAt: string;
  postgres: FileEntry;
  clickhouse?: { tables: ClickHouseTableEntry[] };
  /** The KEK this backup needs; absent on backups written before 0.7.0. */
  key?: BackupKeyInfo;
}

export type AnyBackupManifest = BackupManifest | BackupManifestV1;

export interface CreateBackupOptions {
  /** Overrides BACKUP_DIR; relative paths resolve under INIT_CWD. */
  dir?: string;
  databaseUrl?: string;
  clickhouse?: boolean;
  kind?: BackupKind;
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
  /** Restore even though the configured key cannot unseal the backup (secrets will be unreadable). */
  skipKeyCheck?: boolean;
}

export interface VerifyBackupOptions {
  /** A backup directory with manifest.json, or a directory containing `am-*` backups. */
  dir: string;
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

// A backup holds subscriber addresses, consent records and encrypted data; a bind mount makes
// 0755/0644 readable by every user on the host. The CLI also sets umask 077, and these chmods
// cover the pre-upgrade backup taken by the server process and any caller with a lax umask.
const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;

async function secureDir(path: string): Promise<void> {
  await chmod(path, BACKUP_DIR_MODE);
}

async function secureFile(path: string): Promise<void> {
  await chmod(path, BACKUP_FILE_MODE);
}

// A fixed value sealed by the backup's KEK. It proves at restore time that the configured key
// provider can unwrap what this backup holds, without storing key material or a real data key.
const KEY_CHECK_PLAINTEXT = Buffer.from('agentic-marketing backup key check v1');

/**
 * The key reference for the manifest: the provider id (never the key) and, when the configured
 * provider is available, a sealed check value. A backup container that intentionally has no
 * MASTER_KEY still backs up; it just cannot record a key check.
 */
async function backupKeyInfo(
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
  log: (message: string) => void,
): Promise<BackupKeyInfo | undefined> {
  let provider: ReturnType<typeof keyProviderFromEnv>;
  try {
    provider = keyProviderFromEnv(env);
  } catch (err) {
    log(`warning: not recording a key check: ${(err as Error).message}`);
    return undefined;
  }
  if (!provider) {
    log('no key provider is configured for this process; the manifest records no key check');
    return undefined;
  }
  const info: BackupKeyInfo = { reference: provider.id };
  try {
    const wrapped = await provider.wrap(KEY_CHECK_PLAINTEXT);
    info.check = { kekId: provider.id, wrapped: wrapped.toString('base64') };
  } catch (err) {
    log(`warning: the key provider could not seal a key check (${(err as Error).message}); only its id is recorded`);
  }
  // A trial unseal of a real sealed row catches the case where the configured key belongs to a
  // different workspace/database. It is a warning: the backup itself is still complete.
  try {
    const sample = await readDataKeySample(databaseUrl);
    if (sample) {
      await provider.unwrap(sample.wrappedKey, sample.kekId);
      log('the configured key unwraps a data key in this database');
    }
  } catch (err) {
    log(
      `warning: the configured key does not unwrap a data key in this database (${(err as Error).message}); ` +
        'restoring this backup with it would leave provider and connector secrets unreadable',
    );
  }
  return info;
}

function keyMismatchMessage(reference: string, current: string, err?: Error): string {
  return (
    `this backup needs the key ${reference}, but the configured key provider is ${current} and cannot unseal it` +
    `${err ? ` (${err.message})` : ''}. ` +
    'Set MASTER_KEY to the key that was current when the backup was taken, or add it to MASTER_KEY_PREVIOUS ' +
    '(comma-separated, newest first) and run `am restore` again. ' +
    '`--skip-key-check` restores anyway, but provider, connector and profile secrets will stay unreadable.'
  );
}

/** Proves the configured key can unseal the backup before the database is replaced (#143). */
export async function assertBackupKey(
  manifest: AnyBackupManifest,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = () => {},
): Promise<void> {
  const info = manifest.format === 2 ? manifest.key : undefined;
  if (!info) {
    log('this backup has no key check (it was written before 0.7.0); the key cannot be verified until the app starts');
    return;
  }
  let provider: ReturnType<typeof keyProviderFromEnv>;
  try {
    provider = keyProviderFromEnv(env);
  } catch (err) {
    throw new Error(
      `this backup needs the key ${info.reference}, but the configured key provider is invalid: ${(err as Error).message}. ` +
        'Fix MASTER_KEY/KEY_PROVIDER before restoring (see MASTER_KEY_PREVIOUS for a key that was rotated out).',
    );
  }
  if (!provider) {
    throw new Error(
      `this backup needs the key ${info.reference}, but no key provider is configured. ` +
        'Set MASTER_KEY (or KEY_PROVIDER and its settings) to the key that was current when the backup was taken. ' +
        '`--skip-key-check` restores anyway, but provider and connector secrets will stay unreadable.',
    );
  }
  if (info.check) {
    try {
      const unwrapped = await provider.unwrap(Buffer.from(info.check.wrapped, 'base64'), info.check.kekId);
      if (unwrapped.length !== KEY_CHECK_PLAINTEXT.length || !timingSafeEqual(unwrapped, KEY_CHECK_PLAINTEXT))
        throw new Error('the key check decrypted to an unexpected value');
    } catch (err) {
      throw new Error(keyMismatchMessage(info.reference, provider.id, err as Error));
    }
    log(`key check passed: ${provider.id} can unseal this backup`);
    return;
  }
  if (provider.id === info.reference || provider.owns?.(info.reference)) {
    log(`key reference matches the configured provider (${provider.id}); no sealed check was recorded`);
    return;
  }
  throw new Error(keyMismatchMessage(info.reference, provider.id));
}

/** After pg_restore, unwrap a real data key so a restored install can read its secrets (#143). */
export async function assertRestoredDataKey(
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = () => {},
): Promise<void> {
  const provider = keyProviderFromEnv(env);
  if (!provider)
    throw new Error(
      'the restore loaded Postgres, but no key provider is configured, so provider and connector secrets cannot be read. ' +
        'Set MASTER_KEY (or KEY_PROVIDER and its settings) and run `am restore` again.',
    );
  const sample = await readDataKeySample(databaseUrl);
  if (!sample) {
    log('the restored database has no data keys; there is no sealed secret to check');
    return;
  }
  try {
    const key = await provider.unwrap(sample.wrappedKey, sample.kekId);
    if (key.length !== 32) throw new Error(`unwrapped ${key.length} bytes instead of 32`);
  } catch (err) {
    throw new Error(
      `the restore loaded Postgres, but the configured key provider (${provider.id}) cannot unseal data key ${sample.id} ` +
        `(${sample.kekId}): ${(err as Error).message}. Set MASTER_KEY to the backup's key or add it to MASTER_KEY_PREVIOUS, ` +
        'then run `am restore` again. The database has already been replaced; do not start the app until this passes.',
    );
  }
  log(`unsealed data key ${sample.id} from the restored database`);
}

/** Directory names cannot carry a dash variant safely; keep the release range readable anyway. */
function versionForName(version: string | null): string {
  return (version ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * A head-derived release range ("0.2.3–0.2.4") names several releases. A backup keeps the range in
 * its manifest but uses the newest release in its directory name, where the en dash cannot go.
 */
function newestRelease(version: string | null): string | null {
  return version?.split('–').at(-1)?.trim() || null;
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
  const kind = opts.kind ?? 'manual';
  const version = readVersion();
  const createdAt = new Date();
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const migrationHeadValue = await migrationHead(databaseUrl);
  // The version the data was running, not this build: on upgrade the two differ.
  const recordedFromVersion = await lastServerVersion(databaseUrl, migrationHeadValue);
  const fromVersion = newestRelease(recordedFromVersion);
  // The name needs one version; the manifest keeps the full range and says where it came from.
  const fromVersionLabel =
    recordedFromVersion && recordedFromVersion !== fromVersion ? `${recordedFromVersion} (from migration head)` : recordedFromVersion;
  const name =
    kind === 'pre-upgrade'
      ? `am-pre-upgrade-${versionForName(fromVersion)}-to-${versionForName(version)}-${stamp}`
      : `am-${kind}-${versionForName(version)}-${stamp}`;
  const finalDir = join(dir, name);
  // A partial backup must never look like a completed one: write under a dot-prefixed name and
  // rename only after the manifest exists.
  const tempDir = join(dir, `.${name}.partial`);

  await mkdir(dir, { recursive: true });
  await secureDir(dir);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true, mode: BACKUP_DIR_MODE });
  await secureDir(tempDir);

  try {
    log(`dumping Postgres to ${join(name, 'postgres.dump')}`);
    const dumpPath = join(tempDir, 'postgres.dump');
    await dumpPostgres(databaseUrl, dumpPath);
    await secureFile(dumpPath);
    const key = await backupKeyInfo(env, databaseUrl, log);
    const manifest: BackupManifest = {
      format: 2,
      kind,
      version,
      fromVersion: fromVersionLabel,
      ...(kind === 'pre-upgrade' ? { toVersion: version } : {}),
      migrationHead: migrationHeadValue,
      createdAt: createdAt.toISOString(),
      postgres: await fileEntry(tempDir, 'postgres.dump'),
      ...(key ? { key } : {}),
    };

    if (opts.clickhouse) {
      log('exporting ClickHouse tables');
      manifest.clickhouse = {
        tables: await exportClickHouse({ env, databaseUrl, outDir: tempDir, log }),
      };
    }

    const manifestFile = join(tempDir, 'manifest.json');
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: BACKUP_FILE_MODE });
    await secureFile(manifestFile);
    await rename(tempDir, finalDir);
    await secureDir(finalDir);
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
  params: Record<string, string> = {},
): Promise<Response> {
  const target = new URL(endpoint.url);
  target.searchParams.set('query', query);
  target.searchParams.set('database', database);
  // Custom settings travel as query parameters with their SQL_ prefix (the server allows only
  // that prefix by default); SQL_workspace is what the row policy reads.
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  const headers = new Headers(endpoint.headers);
  if (init.headers) for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  const response = await fetch(target, { ...init, headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000).trim();
    throw new Error(`ClickHouse request failed (${response.status}): ${detail || response.statusText}`);
  }
  return response;
}

/** Rows a SELECT actually produced, from the summary ClickHouse fills with wait_end_of_query=1. */
function summaryRows(response: Response, table: string): number {
  const raw = response.headers.get('x-clickhouse-summary');
  if (!raw) throw new Error(`ClickHouse did not return X-ClickHouse-Summary for ${table}; cannot verify the export`);
  const summary = JSON.parse(raw) as { result_rows?: string | number };
  const rows = Number(summary.result_rows);
  if (!Number.isFinite(rows)) throw new Error(`ClickHouse summary for ${table} has no result_rows; cannot verify the export`);
  return rows;
}

/**
 * Streams every MergeTree-family table as Native. A table with a SELECT row policy returns only
 * the rows of the workspace in SQL_workspace, so it is exported once per workspace (ids from
 * Postgres) and the files are restored together; tables without a policy are one file.
 */
export async function exportClickHouse(opts: {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
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
  // Ask ClickHouse which tables are filtered, rather than hard-coding the list from the events
  // package: an operator's extra policy must not silently produce an empty export.
  const policies = await clickhouseRequest(
    endpoint,
    database,
    'SELECT DISTINCT table FROM system.row_policies WHERE database = currentDatabase() AND select_filter IS NOT NULL FORMAT JSONEachRow',
    { method: 'GET' },
  );
  const scoped = new Set(
    (await policies.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { table: string }).table),
  );

  const databaseUrl = opts.databaseUrl ?? env.DATABASE_URL;
  let workspaceIds: string[] = [];
  if (tables.some((table) => scoped.has(table.name))) {
    if (!databaseUrl) throw new Error('DATABASE_URL is not set; it is needed to export tables that have row policies');
    workspaceIds = await listWorkspaceIds(databaseUrl);
    opts.log?.(`exporting row-policy tables for ${workspaceIds.length} workspace(s)`);
  }

  await mkdir(join(opts.outDir, 'clickhouse'), { recursive: true, mode: BACKUP_DIR_MODE });
  await secureDir(join(opts.outDir, 'clickhouse'));
  const result: ClickHouseTableEntry[] = [];
  for (const table of tables) {
    const name = assertIdentifier(table.name, 'ClickHouse table');
    const totalRowsBefore = Number(table.total_rows) || 0;
    const fileEntries: ClickHouseFileEntry[] = [];
    // The policy is FOR SELECT only, so an export runs once per workspace with the setting set;
    // the same workspace filter is written out so a changed policy cannot widen the result.
    const targets = scoped.has(name) ? workspaceIds.map((workspace) => ({ workspace })) : [{ workspace: undefined }];
    if (scoped.has(name)) {
      const tableDir = `clickhouse/${name}`;
      await mkdir(join(opts.outDir, tableDir), { recursive: true, mode: BACKUP_DIR_MODE });
      await secureDir(join(opts.outDir, tableDir));
    }
    for (const target of targets) {
      const workspace = target.workspace;
      if (workspace !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspace))
        throw new Error(`Invalid workspace id ${workspace}`);
      const file = workspace === undefined ? `clickhouse/${name}.native` : `clickhouse/${name}/${workspace}.native`;
      const where = workspace === undefined ? '' : ` WHERE workspace_id = '${workspace}'`;
      const response = await clickhouseRequest(
        endpoint,
        database,
        `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(name)}${where} FORMAT Native`,
        { method: 'GET' },
        { wait_end_of_query: '1', ...(workspace === undefined ? {} : { SQL_workspace: workspace }) },
      );
      if (!response.body) throw new Error(`ClickHouse returned no data for ${database}.${name}`);
      const path = join(opts.outDir, file);
      await pipeline(
        Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
        createWriteStream(path, { mode: BACKUP_FILE_MODE }),
      );
      await secureFile(path);
      const entry = await fileEntry(opts.outDir, file);
      const rows = summaryRows(response, `${database}.${name}`);
      fileEntries.push({ ...(workspace === undefined ? {} : { workspace }), rows, ...entry });
      opts.log?.(
        `exported ClickHouse ${database}.${name}${workspace ? ` workspace ${workspace}` : ''} (${rows} rows, ${entry.bytes} bytes)`,
      );
    }
    const exported = fileEntries.reduce((sum, entry) => sum + entry.rows, 0);
    if (totalRowsBefore > 0 && exported === 0)
      throw new Error(
        `ClickHouse table ${database}.${name} has ${totalRowsBefore} rows but the export wrote none; ` +
          'refusing to write a backup that claims data it does not contain',
      );
    if (totalRowsBefore !== exported)
      opts.log?.(
        `warning: ClickHouse ${database}.${name} had ${totalRowsBefore} rows before the export and ${exported} were exported ` +
          '(live ingestion, merges, or rows of workspaces no longer in Postgres); both are recorded in the manifest',
      );
    result.push({ name, totalRowsBefore, files: fileEntries });
  }
  return result;
}

/** Replaces each table's contents with every Native file from a backup (one per workspace, or one). */
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
    opts.log?.(`restoring ClickHouse ${database}.${name}`);
    await clickhouseRequest(endpoint, database, `TRUNCATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(name)}`, { method: 'POST' });
    for (const file of table.files) {
      const path = resolve(opts.runDir, file.file);
      if (!path.startsWith(resolve(opts.runDir) + sep)) throw new Error(`manifest path escapes the backup: ${file.file}`);
      // Inserts are not filtered by a SELECT policy, so each workspace's file goes in as-is.
      await clickhouseRequest(endpoint, database, `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(name)} FORMAT Native`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit);
    }
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

const BACKUP_KINDS: BackupKind[] = ['pre-upgrade', 'manual', 'scheduled'];

/** Reads and structurally checks manifest.json (checksums are verified separately). */
export async function readManifest(dir: string): Promise<AnyBackupManifest> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.format !== 1 && manifest.format !== 2)
    throw new Error(`unsupported backup format ${String(manifest.format)}; this version reads formats 1 and 2`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('manifest.json has no version');
  if (typeof manifest.createdAt !== 'string' || !manifest.createdAt) throw new Error('manifest.json has no createdAt');
  if (manifest.migrationHead !== null && typeof manifest.migrationHead !== 'string')
    throw new Error('manifest.json has an invalid migrationHead');
  if (!isFileEntry(manifest.postgres)) throw new Error('manifest.json has no valid postgres entry');
  const clickhouse = manifest.clickhouse as { tables?: unknown } | undefined;
  if (clickhouse !== undefined) {
    if (!clickhouse || !Array.isArray(clickhouse.tables)) throw new Error('manifest.json has an invalid clickhouse entry');
    if (manifest.format === 1) {
      for (const table of clickhouse.tables) {
        const t = table as Record<string, unknown>;
        if (!isFileEntry(t) || typeof t.name !== 'string' || typeof t.rows !== 'number')
          throw new Error('manifest.json has an invalid ClickHouse table entry');
      }
    } else {
      for (const table of clickhouse.tables) {
        const t = table as { name?: unknown; files?: unknown };
        if (typeof t.name !== 'string' || !Array.isArray(t.files)) throw new Error('manifest.json has an invalid ClickHouse table entry');
        for (const file of t.files) {
          if (!isFileEntry(file) || typeof (file as { rows?: unknown }).rows !== 'number')
            throw new Error('manifest.json has an invalid ClickHouse file entry');
          const workspace = (file as { workspace?: unknown }).workspace;
          if (workspace !== undefined && typeof workspace !== 'string')
            throw new Error('manifest.json has an invalid ClickHouse file workspace');
        }
      }
    }
  }
  if (manifest.format === 2) {
    if (!BACKUP_KINDS.includes(manifest.kind as BackupKind)) throw new Error('manifest.json has an invalid kind');
    if (manifest.fromVersion !== null && typeof manifest.fromVersion !== 'string')
      throw new Error('manifest.json has an invalid fromVersion');
    if (manifest.toVersion !== undefined && typeof manifest.toVersion !== 'string')
      throw new Error('manifest.json has an invalid toVersion');
    if (manifest.key !== undefined) {
      const key = manifest.key as { reference?: unknown; check?: unknown };
      if (!key || typeof key !== 'object' || typeof key.reference !== 'string' || !key.reference)
        throw new Error('manifest.json has an invalid key reference');
      if (key.check !== undefined) {
        const check = key.check as { kekId?: unknown; wrapped?: unknown };
        if (!check || typeof check !== 'object' || typeof check.kekId !== 'string' || typeof check.wrapped !== 'string')
          throw new Error('manifest.json has an invalid key check');
      }
    }
  }
  return manifest as unknown as AnyBackupManifest;
}

/** A row for `am backup --list`, from a completed backup's manifest. */
export interface BackupListing {
  name: string;
  dir: string;
  kind: string;
  dataVersion: string | null;
  migrationHead: string | null;
  createdAt: string;
  bytes: number;
  /** What `--list` shows; a 0.2.4 (format 1) backup's ClickHouse part cannot be restored. */
  clickhouse: string;
}

function manifestBytes(manifest: AnyBackupManifest): number {
  let bytes = manifest.postgres.bytes;
  for (const table of manifest.clickhouse?.tables ?? []) {
    if (manifest.format === 1) bytes += (table as FileEntry).bytes;
    else for (const file of (table as ClickHouseTableEntry).files) bytes += file.bytes;
  }
  return bytes;
}

/** Completed backups in a directory, newest first. Partial dot-directories are not backups. */
export async function listBackups(dir: string): Promise<BackupListing[]> {
  const listings: BackupListing[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that does not exist yet simply has no backups; --list should not fail.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('am-')) continue;
    try {
      const path = join(dir, entry.name);
      const manifest = await readManifest(path);
      const legacy = manifest.format === 1;
      listings.push({
        name: entry.name,
        dir: path,
        kind: legacy ? 'legacy' : manifest.kind,
        dataVersion: legacy ? manifest.version : manifest.fromVersion,
        migrationHead: manifest.migrationHead,
        createdAt: manifest.createdAt,
        bytes: manifestBytes(manifest),
        // 0.2.4 exported ClickHouse under row policies as empty files (#129), so "yes" would
        // suggest `am restore --clickhouse` can use them.
        clickhouse: manifest.clickhouse === undefined ? 'no' : legacy ? `empty (${manifest.version}, unusable)` : 'yes',
      });
    } catch {
      // No manifest (or an unreadable one): not a completed backup, so it is not listed.
    }
  }
  return listings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

export interface VerifyStatus {
  /** When a backup set last passed `am backup --verify`. */
  verifiedAt: string;
  /** The backup that passed, for `--health` and for an operator reading the file. */
  backup: string;
}

export const VERIFY_STATUS_FILE = '.verify-status.json';

function verifyStatusPath(dir: string): string {
  return join(dir, VERIFY_STATUS_FILE);
}

/** Records a successful verification next to the backup directory, private like the backups. */
export async function writeVerifyStatus(dir: string, status: VerifyStatus): Promise<void> {
  await mkdir(dir, { recursive: true });
  await secureDir(dir);
  const path = verifyStatusPath(dir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: BACKUP_FILE_MODE });
  await secureFile(temp);
  await rename(temp, path);
  await secureFile(path);
}

export async function readVerifyStatus(dir: string): Promise<VerifyStatus | null> {
  try {
    const status = JSON.parse(await readFile(verifyStatusPath(dir), 'utf8')) as Partial<VerifyStatus>;
    if (typeof status.verifiedAt !== 'string' || typeof status.backup !== 'string') return null;
    return status as VerifyStatus;
  } catch {
    return null;
  }
}

/**
 * `am backup --verify`: re-reads the manifest, re-hashes every file, checks the recorded
 * ClickHouse row counts, and asks `pg_restore --list` to read the dump's table of contents. It
 * writes nothing to a database. On success it records the time in `<dir>/.verify-status.json`,
 * which `am backup --health` uses to fail when a backup has not been verified for too long.
 */
export async function verifyBackup(opts: VerifyBackupOptions): Promise<{ dir: string; manifest: AnyBackupManifest; verifiedAt: string }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const input = resolveUserPath(opts.dir, env);
  let dir: string;
  let parent: string;
  try {
    await stat(join(input, 'manifest.json'));
    dir = input;
    parent = dirname(input);
  } catch {
    const backups = await listBackups(input);
    if (!backups.length) throw new Error(`no completed backups in ${input}`);
    dir = backups[0].dir;
    parent = input;
    log(`verifying the newest backup in ${input}: ${basename(dir)}`);
  }

  const manifest = await readManifest(dir);
  log(`verifying ${dir}`);
  await verifyEntry(dir, manifest.postgres);

  let clickhouseFiles = 0;
  let clickhouseRows = 0;
  for (const table of manifest.clickhouse?.tables ?? []) {
    if (manifest.format === 1) {
      const legacy = table as FileEntry & { rows?: number };
      await verifyEntry(dir, legacy);
      if (typeof legacy.rows === 'number' && (!Number.isInteger(legacy.rows) || legacy.rows < 0))
        throw new Error(`manifest.json records an invalid row count for ClickHouse ${legacy.file}`);
      continue;
    }
    const entry = table as ClickHouseTableEntry;
    let rows = 0;
    for (const file of entry.files) {
      await verifyEntry(dir, file);
      if (!Number.isInteger(file.rows) || file.rows < 0) throw new Error(`manifest.json records an invalid row count for ${file.file}`);
      rows += file.rows;
      clickhouseFiles += 1;
    }
    if (entry.totalRowsBefore > 0 && rows === 0)
      throw new Error(`ClickHouse ${entry.name} had ${entry.totalRowsBefore} rows before the export but its files record none`);
    clickhouseRows += rows;
  }

  // `pg_restore --list` reads the archive without a database: it catches a truncated or corrupt
  // custom-format dump that happens to keep its hash. A missing client is only a warning.
  try {
    await run('pg_restore', ['--list', manifestPath(dir, manifest.postgres.file)], {});
  } catch (err) {
    if (/was not found/.test((err as Error).message)) log('warning: pg_restore was not found; the dump archive structure was not checked');
    else throw new Error(`postgres.dump is not a readable pg_dump archive: ${(err as Error).message}`);
  }

  const verifiedAt = new Date().toISOString();
  await writeVerifyStatus(parent, { verifiedAt, backup: basename(dir) });
  log(
    `verified ${basename(dir)}: ${manifest.postgres.file} ${manifest.postgres.bytes} bytes` +
      `${clickhouseFiles ? `, ${clickhouseFiles} ClickHouse file(s) with ${clickhouseRows} row(s)` : ''}`,
  );
  return { dir, manifest, verifiedAt };
}

/** BACKUP_VERIFY_MAX_AGE_DAYS, default 30 days. */
export function parseVerifyMaxAgeDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 30;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) throw new Error('BACKUP_VERIFY_MAX_AGE_DAYS must be a positive whole number of days');
  return days;
}

/**
 * Verifies a backup, refuses a newer schema unless forced, then replaces Postgres (and optionally
 * ClickHouse). It does not stop the app: the caller warns the operator to do that first.
 */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<AnyBackupManifest> {
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

  // Prove the configured key can unseal this backup before anything is written to Postgres (#143).
  if (opts.skipKeyCheck) log('skipping the key check (--skip-key-check); sealed secrets may stay unreadable');
  else await assertBackupKey(manifest, env, log);

  if (opts.clickhouse) {
    // 0.2.4 wrote format 1 and its ClickHouse files are empty whenever the default row policies
    // are on (#129). Truncating and loading them would delete the event history without a warning.
    if (manifest.format === 1 && manifest.clickhouse)
      throw new Error(
        'This backup was made by 0.2.4, whose ClickHouse export is empty under row policies (#129); ' +
          'restoring it would delete your event history. Restore Postgres only (omit --clickhouse).',
      );
    if (!manifest.clickhouse) throw new Error('this backup has no ClickHouse tables; take a backup with --clickhouse first');
    // Verify every file before the first TRUNCATE: a half-verified restore must not empty a table.
    for (const table of manifest.clickhouse.tables) {
      if (manifest.format === 1) await verifyEntry(dir, table as FileEntry);
      else for (const file of (table as ClickHouseTableEntry).files) await verifyEntry(dir, file);
    }
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

  // Read the erasure log from the live database before it is replaced. A snapshot taken before an
  // erasure still contains that person and their key; replaying the log afterwards removes them
  // again (#144). This is also why a restore must not proceed when the log cannot be read.
  log(`reading erasures recorded in the live database (snapshot from ${manifest.createdAt})`);
  const erasureLog = await readErasureLog(databaseUrl);

  log('restoring Postgres (this replaces the current database)');
  await restorePostgres(databaseUrl, manifestPath(dir, manifest.postgres.file));

  // The pre-restore check used the sealed value in the manifest; this proves the key also opens a
  // real data key in the restored data, still before the app is started. `--skip-key-check`
  // deliberately overrides both. A backup written without a key reference has nothing to compare.
  if (!opts.skipKeyCheck && manifest.format === 2 && manifest.key) await assertRestoredDataKey(databaseUrl, env, log);

  if (erasureLog.erasures.length || erasureLog.tombstones.length) {
    log(`replaying ${erasureLog.erasures.length} erasure(s) and ${erasureLog.tombstones.length} tombstone(s) recorded after the snapshot`);
    const replayed = await replayErasures(databaseUrl, erasureLog, { log });
    log(
      `erasures replayed: ${replayed.profiles} profile(s) removed from the restored snapshot, ` +
        `${replayed.tombstones} tombstone(s) restored` +
        (replayed.skipped ? `, ${replayed.skipped} entr(ies) skipped for workspaces the snapshot does not have` : ''),
    );
  } else log('no erasures to replay; the snapshot has nothing to resurrect');

  if (opts.clickhouse && manifest.clickhouse) {
    log('restoring ClickHouse');
    await restoreClickHouse({ runDir: dir, tables: manifest.clickhouse.tables as ClickHouseTableEntry[], env, log });
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

/**
 * The heartbeat the scheduler writes for `am backup --health`. The timestamp is both the JSON
 * value and the file mtime, so a liveness check works even if the body is being replaced.
 */
export interface ScheduleStatus {
  lastRunAt: string | null;
  lastOk: boolean;
  lastError?: string;
  nextRunAt: string;
}

export const SCHEDULE_STATUS_FILE = '.schedule-status.json';
const SCHEDULE_STALE_MS = 2 * 60_000;

function scheduleStatusPath(dir: string): string {
  return join(dir, SCHEDULE_STATUS_FILE);
}

export async function writeScheduleStatus(dir: string, status: ScheduleStatus): Promise<void> {
  await mkdir(dir, { recursive: true });
  await secureDir(dir);
  const path = scheduleStatusPath(dir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Rename keeps readers from seeing a half-written file; both name and mode are restricted.
  await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: BACKUP_FILE_MODE });
  await secureFile(temp);
  await rename(temp, path);
  await secureFile(path);
}

export async function readScheduleStatus(dir: string): Promise<ScheduleStatus | null> {
  try {
    return JSON.parse(await readFile(scheduleStatusPath(dir), 'utf8')) as ScheduleStatus;
  } catch {
    return null;
  }
}

/** Next minute on which the cron expression matches, in UTC. */
export function nextCronRun(spec: CronSpec, from: Date): Date {
  const next = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  // Five years of minutes: enough for any valid five-field expression (leap days included).
  for (let i = 0; i < 5 * 366 * 24 * 60; i += 1) {
    if (cronMatches(spec, next)) return next;
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  throw new Error(`BACKUP_CRON "${spec.expression}" never matches`);
}

export async function backupHealth(
  opts: { dir?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ ok: boolean; reason: string }> {
  const env = opts.env ?? process.env;
  const dir = opts.dir ? resolveUserPath(opts.dir, env) : resolveBackupDir(env);
  const now = opts.now ?? new Date();
  const path = scheduleStatusPath(dir);
  let age: number;
  try {
    age = now.getTime() - (await stat(path)).mtimeMs;
  } catch {
    return { ok: false, reason: `no scheduler heartbeat at ${path}` };
  }
  if (age > SCHEDULE_STALE_MS) {
    return { ok: false, reason: `scheduler heartbeat is ${Math.round(age / 1000)}s old; the backup service may be stuck` };
  }
  const status = await readScheduleStatus(dir);
  if (!status) return { ok: false, reason: `scheduler heartbeat at ${path} is unreadable` };
  if (!status.lastOk) {
    const when = status.lastRunAt ? ` at ${status.lastRunAt}` : '';
    return { ok: false, reason: `last scheduled backup${when} failed: ${status.lastError ?? 'unknown error'}` };
  }
  // A heartbeat only proves the scheduler is alive. A backup that has never been verified is a
  // hypothesis, so --health also enforces the age of the last successful verification (#145).
  let maxAgeDays: number;
  try {
    maxAgeDays = parseVerifyMaxAgeDays(env.BACKUP_VERIFY_MAX_AGE_DAYS);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const verification = await readVerifyStatus(dir);
  if (!verification)
    return {
      ok: false,
      reason: `no successful backup verification in ${dir}; run \`am backup --verify\` (or let the backup service verify each run)`,
    };
  const verifiedAt = Date.parse(verification.verifiedAt);
  if (!Number.isFinite(verifiedAt)) return { ok: false, reason: `the verification record in ${dir} has an invalid timestamp` };
  const verifiedDays = (now.getTime() - verifiedAt) / 86_400_000;
  if (verifiedDays > maxAgeDays)
    return {
      ok: false,
      reason:
        `last successful backup verification of ${verification.backup} is ${Math.floor(verifiedDays)} day(s) old, ` +
        `older than BACKUP_VERIFY_MAX_AGE_DAYS=${maxAgeDays}; run \`am backup --verify\` and do a restore drill`,
    };
  return {
    ok: true,
    reason:
      `scheduler alive; last verification of ${verification.backup} was ${verification.verifiedAt}; ` +
      `next backup at ${status.nextRunAt}`,
  };
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

  const dir = env.BACKUP_DIR?.trim() ? resolveUserPath(env.BACKUP_DIR.trim(), env) : resolveBackupDir(env);
  const status: ScheduleStatus = {
    lastRunAt: null,
    lastOk: true,
    nextRunAt: nextCronRun(spec, new Date()).toISOString(),
  };
  const heartbeat = async () => {
    // Touching the file every minute is what --health uses to tell a live scheduler from a hung one.
    status.nextRunAt = nextCronRun(spec, new Date()).toISOString();
    try {
      await writeScheduleStatus(dir, status);
    } catch (err) {
      log(`could not write schedule status: ${(err as Error).message}`);
    }
  };
  await heartbeat();

  // A backup can take longer than the health window; keep proving the scheduler is alive while
  // createBackup runs, not only between minutes.
  const heartbeatTimer = setInterval(() => void heartbeat(), 60_000);
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
        status.lastRunAt = now.toISOString();
        try {
          // createBackup logs the final path; a failure is not fatal for the scheduler.
          await createBackup({ clickhouse: opts.clickhouse, keepDays, kind: 'scheduled', env, log, dir });
          status.lastOk = true;
          delete status.lastError;
        } catch (err) {
          status.lastOk = false;
          status.lastError = (err as Error).message;
          log(`backup failed: ${status.lastError}`);
        }
        await heartbeat();
      } else {
        await heartbeat();
      }
      await sleepUntilNextMinute(stop.signal);
    }
  } finally {
    clearInterval(heartbeatTimer);
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  }
  log('scheduled backups stopped');
  return 0;
}
