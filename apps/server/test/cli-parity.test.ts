import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCli } from '../../../test-support/cli';
import { TEMPLATE_DB, testDatabaseUrl } from './harness';

// #518 review: the bundled CLI is used by other tests as if it were the real one. A bundle is not
// the same program when `import.meta.url` points into the temp directory: migration files, the
// default web assets and CHANGELOG.md all resolved wrongly. Run the same commands through the
// bundle and through tsx (the checkout as published) and compare what an operator sees.

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const cliSource = join(root, 'apps/server/src/cli.ts');
const tsxLoader = createRequire(join(root, 'package.json')).resolve('tsx');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function execute(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Result> {
  try {
    const { stdout, stderr } = await run(argv[0]!, argv.slice(1), { cwd, env, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const error = err as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC' });

/** A complete configuration, without any of the real environment leaking in. */
function configEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    DATABASE_URL: testDatabaseUrl(TEMPLATE_DB).toString(),
    APP_DB_ROLE: 'am_app_test',
    APP_DB_PASSWORD: 'am_app_test_password',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    CLICKHOUSE_DATABASE: 'am_cli_parity',
    NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
    VALKEY_URL: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
    VALKEY_PREFIX: 'am_cli_parity',
  };
}

let bundle = '';
let cwd = '';

const throughBundle = (args: string[], env = baseEnv()) => execute([process.execPath, bundle, ...args], env, cwd);
const throughTsx = (args: string[], env = baseEnv()) =>
  execute([process.execPath, '--import', tsxLoader, '--', cliSource, ...args], env, cwd);

describe('bundled CLI parity with tsx', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    bundle = await buildTestCli();
    cwd = await mkdtemp(join(tmpdir(), 'am-cli-parity-'));
  }, 120_000);
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('prints the same help', async () => {
    const [b, t] = await Promise.all([throughBundle(['--help']), throughTsx(['--help'])]);
    expect(b.code).toBe(t.code);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(t.stdout);
    expect(b.stderr).toBe(t.stderr);
  });

  it('prints the same version', async () => {
    const [b, t] = await Promise.all([throughBundle(['--version']), throughTsx(['--version'])]);
    expect(b.code).toBe(t.code);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(t.stdout);
    expect(b.stderr).toBe(t.stderr);
  });

  it('reports a missing configuration the same way', async () => {
    const [b, t] = await Promise.all([throughBundle(['migrate']), throughTsx(['migrate'])]);
    expect(b.code).toBe(t.code);
    expect(b.code).toBe(1);
    expect(b.stderr).toBe(t.stderr);
    expect(b.stderr).toContain('DATABASE_URL is missing');
  });

  it('finds the checkout CHANGELOG.md for upgrade-notes', async () => {
    const [b, t] = await Promise.all([throughBundle(['upgrade-notes', '0.11.0']), throughTsx(['upgrade-notes', '0.11.0'])]);
    expect(b.code).toBe(t.code);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(t.stdout);
    expect(b.stderr).toBe(t.stderr);
    expect(b.stdout).toContain('Upgrading from 0.11.0');
  });

  it('finds the migration files and reports the database up to date', async () => {
    const env = configEnv();
    const [b, t] = await Promise.all([throughBundle(['migrate'], env), throughTsx(['migrate'], env)]);
    expect(b.code).toBe(t.code);
    expect(b.code).toBe(0);
    expect(b.stdout).toContain('database is up to date');
    expect(t.stdout).toContain('database is up to date');
  });
});
