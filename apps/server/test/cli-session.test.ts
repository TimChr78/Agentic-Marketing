import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

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
