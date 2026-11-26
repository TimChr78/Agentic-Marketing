import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentic-marketing/db';
import { localKeyProvider, rewrapDataKeys } from '@agentic-marketing/secrets';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { buildTestCli } from '../../../test-support/cli';
import type { Config } from '../src/config';
import { assertRestoredDataKey } from '../src/ops/backup-lib';
import { checkAdminRole, checkDataKeyProvider } from '../src/ops/checks';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN_TS = join(SERVER_DIR, 'src/main.ts');
const TSX_BIN = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

// #1228, #1229 and #1235 on the role the docs used to call only "an owner of the database": a
// login role that owns every table but is NOSUPERUSER NOBYPASSRLS. Under FORCE ROW LEVEL SECURITY
// it sees no tenant row, so `am rotate-keys` re-wrapped nothing, `am bootstrap` failed the
// workspace policy after creating the user, and the server refused every sign-in. Each command
// must refuse with the role and the ALTER ROLE … BYPASSRLS fix instead of reporting success.

// Several disposable databases; dropping them under a full parallel run can pass 60 s.
vi.setConfig({ hookTimeout: 300_000 });

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const roles: string[] = [];
const emptyDbs: string[] = [];

afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
  const maint = new pg.Client({
    connectionString: Object.assign(new URL(process.env.TEST_DATABASE_URL ?? ''), { pathname: '/postgres' }).toString(),
  });
  await maint.connect();
  try {
    for (const name of emptyDbs) await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    for (const role of roles) await maint.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  } finally {
    await maint.end();
  }
});

const suffixOf = () => randomBytes(4).toString('hex');

/** A login role that owns every table (and sequence) in `d`, without BYPASSRLS. */
async function ownEverything(d: Awaited<ReturnType<typeof createDisposableDb>>) {
  const role = `am_role_ops_${suffixOf()}`;
  roles.push(role);
  await d.db.admin.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
  await d.db.admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
  const tables = await d.db.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const { tablename } of tables.rows) await d.db.admin.query(`ALTER TABLE "public"."${tablename}" OWNER TO ${role}`);
  const sequences = await d.db.admin.query<{ sequencename: string }>("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'");
  for (const { sequencename } of sequences.rows) await d.db.admin.query(`ALTER SEQUENCE "public"."${sequencename}" OWNER TO ${role}`);
  const url = new URL(d.url.toString());
  url.username = role;
  url.password = 'rls-password';
  return { role, url: url.toString() };
}

const maintenanceUrl = () => Object.assign(new URL(process.env.TEST_DATABASE_URL ?? ''), { pathname: '/postgres' }).toString();

/** A database with no schema at all, for the startup guard on an empty install. */
async function emptyDatabase(prefix: string): Promise<URL> {
  const name = `am_${prefix}_${process.pid}_${suffixOf()}`;
  const maint = new pg.Client({ connectionString: maintenanceUrl() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maint.query(`CREATE DATABASE ${name}`);
  } finally {
    await maint.end();
  }
  emptyDbs.push(name);
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  url.pathname = `/${name}`;
  return url;
}

function collectOutput(child: ChildProcess): () => string {
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

async function waitForOutput(output: () => string, child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(output())) return true;
    if (child.exitCode !== null || child.signalCode !== null) return pattern.test(output());
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const serverEnv = (databaseUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_DB_ROLE: 'am_ops_test_app',
  APP_DB_PASSWORD: 'am_ops_test_password',
  AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SKIP_MIGRATIONS: 'true',
  ROLE: 'api',
  PORT: '0',
  PUBLIC_URL: 'http://localhost:3000',
  CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  CLICKHOUSE_DATABASE: 'am_role_start',
  NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
  NATS_NAMESPACE: 'am_role_start',
  VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
  VALKEY_PREFIX: 'am_role_start',
  ...extra,
});

function startServer(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn(TSX_BIN, [MAIN_TS], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, output: collectOutput(child) };
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe.skipIf(!hasTestDatabase())('the admin role under FORCE RLS (#1228, #1229, #1235)', () => {
  it('#1228 rewrapDataKeys refuses instead of reporting success over invisible keys', async () => {
    const d = await createDisposableDb('role_rotate');
    open.push(d);
    const oldKey = Buffer.alloc(32, 7).toString('base64');
    const newKey = Buffer.alloc(32, 9).toString('base64');
    const oldProvider = localKeyProvider(oldKey);
    const newProvider = localKeyProvider(newKey, [oldKey]);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_rotate_owner', $2, $3)`,
      [d.workspace, oldProvider.id, await oldProvider.wrap(Buffer.alloc(32, 3))],
    );
    const owner = await ownEverything(d);

    // The literal pool `am rotate-keys` uses.
    const db = ownerDb(owner.url);
    try {
      await expect(rewrapDataKeys(db.admin, newProvider)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db.close();
    }

    const left = await d.db.admin.query<{ kek_id: string }>('SELECT kek_id FROM data_keys WHERE workspace_id = $1', [d.workspace]);
    expect(left.rows.map((row) => row.kek_id)).toEqual([oldProvider.id]);
  }, 60_000);

  it('#1235 am doctor fails the admin-role check and app startup uses the same assertion', async () => {
    const d = await createDisposableDb('role_doctor');
    open.push(d);
    const owner = await ownEverything(d);
    const db = ownerDb(owner.url);
    try {
      const found = await checkAdminRole(db);
      expect(found.status).toBe('fail');
      expect(found.message).toContain(owner.role);
      expect(found.message).toContain('BYPASSRLS');
      expect(found.hint).toContain('ALTER ROLE');
    } finally {
      await db.close();
    }
    // The same check passes for the superuser the tests run as.
    const superuser = ownerDb(d.url.toString());
    try {
      expect(await checkAdminRole(superuser)).toMatchObject({ status: 'ok' });
    } finally {
      await superuser.close();
    }
  }, 60_000);

  it('#1221 the live key check reads data_keys as the owner instead of reporting no keys', async () => {
    const d = await createDisposableDb('role_key_check');
    open.push(d);
    const masterKey = Buffer.alloc(32, 7).toString('base64');
    const provider = localKeyProvider(masterKey);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_live_check', $2, $3)`,
      [d.workspace, provider.id, await provider.wrap(Buffer.alloc(32, 5))],
    );
    const owner = await ownEverything(d);
    const config = {
      adminDatabaseUrl: owner.url,
      masterKey,
      previousMasterKeys: [],
      keys: { provider: 'local' },
    } as unknown as Config;

    const db = ownerDb(owner.url);
    try {
      const found = await checkDataKeyProvider(config, db);
      expect(found.status).toBe('ok');
      expect(found.message).toContain(provider.id);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('#1221 the post-restore key check fails a wrong key as the owner instead of skipping it', async () => {
    const d = await createDisposableDb('role_restore_key');
    open.push(d);
    const masterKey = Buffer.alloc(32, 7).toString('base64');
    const wrongKey = Buffer.alloc(32, 9).toString('base64');
    const provider = localKeyProvider(masterKey);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_restore_key', $2, $3)`,
      [d.workspace, provider.id, await provider.wrap(Buffer.alloc(32, 6))],
    );
    const owner = await ownEverything(d);

    // The right key proves the check read the row.
    const lines: string[] = [];
    await assertRestoredDataKey(owner.url, { MASTER_KEY: masterKey }, (line) => lines.push(line));
    expect(lines.join(' ')).toContain('unsealed data key dk_restore_key');

    // A wrong key must fail, not resolve because the table looked empty.
    await expect(assertRestoredDataKey(owner.url, { MASTER_KEY: wrongKey }, () => {})).rejects.toThrow(/cannot unseal data key/);
  }, 60_000);

  it('#1229 am bootstrap refuses before creating the user and names the role', async () => {
    const d = await createDisposableDb('role_bootstrap');
    open.push(d);
    const owner = await ownEverything(d);
    const cli = await buildTestCli();
    const email = `bootstrap-owner-${suffixOf()}@example.com`;
    const appRole = `am_role_app_${suffixOf()}`;
    roles.push(appRole);
    const env = {
      ...process.env,
      DATABASE_URL: owner.url,
      APP_DB_ROLE: appRole,
      APP_DB_PASSWORD: 'rls-app-password',
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      CLICKHOUSE_DATABASE: `am_role_bootstrap_${suffixOf()}`,
      CLICKHOUSE_ROW_POLICIES: process.env.CLICKHOUSE_ROW_POLICIES ?? 'auto',
      NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
      NATS_NAMESPACE: d.url.pathname.slice(1),
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      VALKEY_PREFIX: d.url.pathname.slice(1),
      PUBLIC_URL: 'http://localhost:3000',
      AM_BOOTSTRAP_PASSWORD: 'correct-horse-battery-staple',
    };
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [cli, 'bootstrap', '--email', email, '--workspace', 'Owner role'],
        { env, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && typeof (err as { code?: unknown }).code !== 'number') reject(err);
          else resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
        },
      );
      child.stdin?.end();
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(owner.role);
    expect(result.stderr).toContain('BYPASSRLS');
    expect(result.stdout).not.toContain('created workspace');
    // The guard runs before signUpEmail, so no account is left behind without a workspace.
    const user = await d.db.admin.query('SELECT 1 FROM "user" WHERE email = $1', [email]);
    expect(user.rowCount).toBe(0);
  }, 180_000);

  it('#1220 am backup --clickhouse refuses a non-bypass owner before the dump', async () => {
    const d = await createDisposableDb('role_backup');
    open.push(d);
    const owner = await ownEverything(d);
    const cli = await buildTestCli();
    const dir = await mkdtemp(join(tmpdir(), 'am-role-backup-'));
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [cli, 'backup', '--clickhouse', '--to', dir],
          {
            env: {
              ...process.env,
              DATABASE_URL: owner.url,
              CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
              CLICKHOUSE_DATABASE: `am_role_backup_${suffixOf()}`,
            },
            maxBuffer: 4 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err && typeof (err as { code?: unknown }).code !== 'number') reject(err);
            else resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
          },
        );
        child.stdin?.end();
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(owner.role);
      expect(result.stderr).toContain('BYPASSRLS');
      // The refusal happens before the temporary directory and the dump.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('#1221 am doctor bounds the locked data_keys read and closes its client', async () => {
    const d = await createDisposableDb('role_key_lock');
    open.push(d);
    const masterKey = Buffer.alloc(32, 7).toString('base64');
    const provider = localKeyProvider(masterKey);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_locked', $2, $3)`,
      [d.workspace, provider.id, await provider.wrap(Buffer.alloc(32, 5))],
    );
    const owner = await ownEverything(d);
    const blocker = new pg.Client({ connectionString: d.url.toString() });
    await blocker.connect();
    const db = ownerDb(owner.url);
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE data_keys IN ACCESS EXCLUSIVE MODE');
      const config = {
        adminDatabaseUrl: owner.url,
        masterKey,
        previousMasterKeys: [],
        keys: { provider: 'local' },
      } as unknown as Config;

      const started = Date.now();
      const found = await checkDataKeyProvider(config, db);
      expect(found.status).toBe('fail');
      expect(found.message).toMatch(/timed out|did not finish|lock timeout/i);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await db.close();
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }

    // The old race returned while the ALTER was still waiting on the lock. Poll briefly so the
    // backend has a moment to finish its rollback and disconnect.
    let active = -1;
    for (let attempt = 0; attempt < 20 && active !== 0; attempt += 1) {
      const rows = await d.db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = $1 AND pid <> pg_backend_pid() AND state = 'active'`,
        [owner.role],
      );
      active = rows.rows[0]?.n ?? 0;
      if (active !== 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(active).toBe(0);
  }, 180_000);

  it('#1235 refuses a non-bypass role at startup even on an empty database', async () => {
    const url = await emptyDatabase('role_empty');
    const role = `am_role_empty_login_${suffixOf()}`;
    roles.push(role);
    const maint = new pg.Client({ connectionString: maintenanceUrl() });
    await maint.connect();
    try {
      await maint.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    } finally {
      await maint.end();
    }
    const login = new URL(url.toString());
    login.username = role;
    login.password = 'rls-password';

    const result = await new Promise<{ code: number | null; output: string; killed: boolean }>((resolve, reject) => {
      const child = execFile(
        TSX_BIN,
        [MAIN_TS],
        {
          cwd: SERVER_DIR,
          env: serverEnv(login.toString()),
          maxBuffer: 8 * 1024 * 1024,
          timeout: 120_000,
        },
        (err, stdout, stderr) => {
          const killed = Boolean((err as { killed?: boolean } | null)?.killed);
          if (err && typeof (err as { code?: unknown }).code !== 'number' && !killed) reject(err);
          else
            resolve({
              code: typeof (err as { code?: unknown } | null)?.code === 'number' ? ((err as { code: number }).code ?? null) : null,
              output: `${stdout}${stderr}`,
              killed,
            });
        },
      );
      child.stdin?.end();
    });

    if (result.killed) throw new Error(`the server did not exit; output:\n${result.output}`);
    expect(result.code).toBe(1);
    expect(result.output).toContain(role);
    expect(result.output).toContain('BYPASSRLS');
    expect(result.output).not.toContain('api listening');
  }, 180_000);

  it('#1235 starts on a migrated database with the Compose-style superuser', async () => {
    const d = await createDisposableDb('role_start_ok');
    open.push(d);
    const { child, output } = startServer(serverEnv(d.url.toString()));
    try {
      expect(await waitForOutput(output, child, /api listening/, 90_000)).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 180_000);
});

function ownerDb(url: string) {
  return createDb({ adminUrl: url, appUrl: url, poolSize: 1 });
}
