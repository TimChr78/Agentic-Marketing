import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDb } from '@agentic-marketing/db';
import { localKeyProvider, rewrapDataKeys } from '@agentic-marketing/secrets';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { buildTestCli } from '../../../test-support/cli';
import type { Config } from '../src/config';
import { assertRestoredDataKey } from '../src/ops/backup-lib';
import { checkAdminRole, checkDataKeyProvider } from '../src/ops/checks';

// #1228, #1229 and #1235 on the role the docs used to call only "an owner of the database": a
// login role that owns every table but is NOSUPERUSER NOBYPASSRLS. Under FORCE ROW LEVEL SECURITY
// it sees no tenant row, so `am rotate-keys` re-wrapped nothing, `am bootstrap` failed the
// workspace policy after creating the user, and the server refused every sign-in. Each command
// must refuse with the role and the ALTER ROLE … BYPASSRLS fix instead of reporting success.

// Several disposable databases; dropping them under a full parallel run can pass 60 s.
vi.setConfig({ hookTimeout: 180_000 });

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const roles: string[] = [];

afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
  const maint = new pg.Client({
    connectionString: Object.assign(new URL(process.env.TEST_DATABASE_URL ?? ''), { pathname: '/postgres' }).toString(),
  });
  await maint.connect();
  try {
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
});

function ownerDb(url: string) {
  return createDb({ adminUrl: url, appUrl: url, poolSize: 1 });
}
