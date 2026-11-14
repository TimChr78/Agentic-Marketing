import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetPasswordForEmail } from '../src/passwordReset';
import { APP_ROLE, cookieOf, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// `am reset-password` is the break-glass path when a password may be compromised. It must end the
// person's sessions in the same operation: a stolen cookie must stop working, while nobody else's
// session is touched.

const root = fileURLToPath(new URL('../../..', import.meta.url));
const cliSource = join(root, 'apps/server/src/cli.ts');
const tsxLoader = createRequire(join(root, 'package.json')).resolve('tsx');

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['--import', tsxLoader, '--', cliSource, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end();
  });
}

let t: Awaited<ReturnType<typeof startTestServer>>;
let user: User;
let other: User;
let ws = '';

const whoami = (cookie: string) =>
  fetch(`${t.base}/v1/workspace.get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: t.base, cookie, 'x-workspace-id': ws },
    body: '{}',
  });

beforeAll(async () => {
  t = await startTestServer('cli_session', testPort(2506));
  user = await t.signUp(`cli-reset-${Date.now()}@example.com`);
  other = await t.signUp(`cli-other-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [user, 'owner'],
    [other, 'viewer'],
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('am reset-password', { timeout: 180_000 }, () => {
  it('ends the person’s existing sessions and leaves everyone else signed in', async () => {
    expect((await whoami(user.cookie)).status).toBe(200);

    const reset = await cli(['reset-password', '--email', user.email], {
      DATABASE_URL: testDatabaseUrl(t.dbName).toString(),
      APP_DB_ROLE: APP_ROLE.appRole,
      APP_DB_PASSWORD: APP_ROLE.appRolePassword,
      AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      CLICKHOUSE_DATABASE: t.dbName,
      NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
      NATS_NAMESPACE: t.dbName,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
      VALKEY_PREFIX: t.dbName,
      PUBLIC_URL: t.base,
      AM_RESET_PASSWORD: 'a-brand-new-password',
    });
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain(`password updated for ${user.email}`);

    // The cookie issued before the reset is no longer a session.
    expect((await whoami(user.cookie)).status).toBe(401);
    // Only that person's sessions were revoked.
    expect((await whoami(other.cookie)).status).toBe(200);
  });
});

// #913: the credential write and the session deletion are one transaction, and the CLI writes the
// same audit entry the web reset writes. A crash between the two used to leave every session stolen
// before the reset valid, with no audit row recording that it happened.
describe('the reset itself (#913)', { timeout: 60_000 }, () => {
  let txn: User;
  let txnWs = '';
  const hashOf = async (userId: string) => {
    const { rows } = await t.srv.db.admin.query<{ password: string | null }>(
      `SELECT password FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [userId],
    );
    return rows[0]?.password ?? null;
  };
  const whoamiIn = (cookie: string) =>
    fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base, cookie, 'x-workspace-id': txnWs },
      body: '{}',
    });
  const signIn = (email: string, password: string) =>
    fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email, password }),
    });
  const audits = async () => {
    const { rows } = await t.srv.db.admin.query<{
      surface: string;
      principal_type: string;
      principal_id: string;
      ok: boolean;
      ip: string | null;
    }>(
      `SELECT surface, principal_type, principal_id, ok, ip FROM audit_log
        WHERE workspace_id = $1 AND command = 'auth.passwordReset' ORDER BY seq`,
      [txnWs],
    );
    return rows;
  };

  beforeAll(async () => {
    txn = await t.signUp(`cli-txn-${Date.now()}@example.com`);
    txnWs = await t.workspaceWith([[txn, 'owner']]);
  });

  it('leaves the password and the sessions alone when the session deletion fails', async () => {
    const before = await hashOf(txn.id);
    expect(before).not.toBeNull();
    await expect(
      resetPasswordForEmail(
        {
          db: t.srv.db,
          auth: t.srv.auth,
          revokeSessions: async () => {
            throw new Error('session store unavailable');
          },
        },
        txn.email,
        'a-rolled-back-password',
      ),
    ).rejects.toThrow('session store unavailable');
    // The password write rolled back with it: the old password still works and the session is live.
    expect(await hashOf(txn.id)).toBe(before);
    expect((await whoamiIn(txn.cookie)).status).toBe(200);
    expect((await signIn(txn.email, 'a-rolled-back-password')).status).toBe(401);
    expect(await audits()).toEqual([]);
  });

  it('commits the password, ends the old sessions and records the CLI audit entry', async () => {
    await resetPasswordForEmail({ db: t.srv.db, auth: t.srv.auth }, txn.email, 'a-committed-password');

    expect(await hashOf(txn.id)).not.toBeNull();
    expect((await whoamiIn(txn.cookie)).status).toBe(401);
    const signedIn = await signIn(txn.email, 'a-committed-password');
    expect(signedIn.status).toBe(200);
    expect((await whoamiIn(cookieOf(signedIn))).status).toBe(200);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'cli', principal_type: 'user', principal_id: txn.id, ok: true, ip: null });
  });
});
