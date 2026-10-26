import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { run } from '../src/ops/init';

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'am-init-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function parseEnv(text: string) {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

async function runQuietly(args: string[]) {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts) => output.push(parts.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...parts) => output.push(parts.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...parts) => output.push(parts.join(' ')));
  const code = await run(args);
  return { code, output: output.join('\n') };
}

describe('am init', () => {
  it('writes .env with mode 0600, fresh secrets and the requested URLs', async () => {
    const dir = await tempDir();
    const out = join(dir, '.env');
    const { code, output } = await runQuietly([
      '--out',
      out,
      '--public-url',
      'https://marketing.example.com',
      '--links-url',
      'https://links.example.com',
    ]);

    expect(code).toBe(0);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const text = await readFile(out, 'utf8');
    expect(text.startsWith('# Copy to .env')).toBe(true);
    expect(text).toContain('# During a master key rotation only');
    expect(text).toContain('PUBLIC_URL=https://marketing.example.com');
    expect(text).toContain('PUBLIC_LINKS_URL=https://links.example.com');
    expect(text).toContain('POSTGRES_PASSWORD=');
    expect(text).toContain('APP_DB_PASSWORD=');

    const env = parseEnv(text);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.APP_DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.AUTH_SECRET).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(env.MASTER_KEY, 'base64')).toHaveLength(32);
    expect(output).toContain(out);
    expect(output).toContain('generated: POSTGRES_PASSWORD, APP_DB_PASSWORD, AUTH_SECRET, MASTER_KEY');

    for (const secret of [env.POSTGRES_PASSWORD, env.APP_DB_PASSWORD, env.AUTH_SECRET, env.MASTER_KEY])
      expect(output).not.toContain(secret);
  });

  it('generates different secrets on two runs', async () => {
    const dir = await tempDir();
    const first = join(dir, 'first.env');
    const second = join(dir, 'second.env');
    const flags = ['--public-url', 'https://marketing.example.com', '--links-url', 'https://links.example.com'];

    expect((await runQuietly(['--out', first, ...flags])).code).toBe(0);
    expect((await runQuietly(['--out', second, ...flags])).code).toBe(0);

    const a = parseEnv(await readFile(first, 'utf8'));
    const b = parseEnv(await readFile(second, 'utf8'));
    for (const key of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'AUTH_SECRET', 'MASTER_KEY']) expect(a[key]).not.toBe(b[key]);
  });

  it('refuses to overwrite an existing file without --force', async () => {
    const dir = await tempDir();
    const out = join(dir, '.env');
    const flags = ['--public-url', 'https://marketing.example.com'];
    expect((await runQuietly(['--out', out, ...flags])).code).toBe(0);
    const before = await readFile(out, 'utf8');

    const refused = await runQuietly(['--out', out, ...flags]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('already exists');
    expect(await readFile(out, 'utf8')).toBe(before);

    const forced = await runQuietly(['--out', out, '--force', ...flags]);
    expect(forced.code).toBe(0);
    expect(await readFile(out, 'utf8')).not.toBe(before);
  });

  it('writes an env file that loadConfig accepts', async () => {
    const dir = await tempDir();
    const out = join(dir, '.env');
    expect((await runQuietly(['--out', out, '--public-url', 'https://marketing.example.com'])).code).toBe(0);

    const env = parseEnv(await readFile(out, 'utf8'));
    // Compose builds DATABASE_URL from POSTGRES_PASSWORD; outside compose the operator sets it.
    env.DATABASE_URL = `postgres://am:${env.POSTGRES_PASSWORD}@localhost:5432/am`;
    const config = loadConfig(env);
    expect(config.publicUrl).toBe('https://marketing.example.com');
    expect(config.masterKey).toBe(env.MASTER_KEY);
    expect(config.authSecret).toBe(env.AUTH_SECRET);
  });

  it('uses INIT_CWD for the default output path', async () => {
    const dir = await tempDir();
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = dir;
    try {
      expect((await runQuietly(['--public-url', 'https://marketing.example.com'])).code).toBe(0);
      const text = await readFile(join(dir, '.env'), 'utf8');
      expect(text).toContain('PUBLIC_URL=https://marketing.example.com');
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previous;
    }
  });

  it('keeps the template URLs when stdin is not a TTY and no flags are given', async () => {
    const dir = await tempDir();
    const out = join(dir, '.env');
    const { code, output } = await runQuietly(['--out', out]);
    expect(code).toBe(0);
    const env = parseEnv(await readFile(out, 'utf8'));
    expect(env.PUBLIC_URL).toBe('http://localhost:3000');
    expect(env.PUBLIC_LINKS_URL).toBe('');
    expect(output).toContain('keeping the example value');
  });

  it('rejects invalid or non-HTTP URLs', async () => {
    const dir = await tempDir();
    const out = join(dir, '.env');

    const badUrl = await runQuietly(['--out', out, '--public-url', 'not a url']);
    expect(badUrl.code).toBe(1);
    expect(badUrl.output).toContain('PUBLIC_URL is not a valid URL');

    const badProtocol = await runQuietly(['--out', out, '--public-url', 'ftp://marketing.example.com']);
    expect(badProtocol.code).toBe(1);
    expect(badProtocol.output).toContain('must start with http:// or https://');
  });

  it('warns when PUBLIC_URL is plain HTTP on a non-loopback host', async () => {
    const dir = await tempDir();
    const { code, output } = await runQuietly(['--out', join(dir, '.env'), '--public-url', 'http://192.168.1.20:3000']);
    expect(code).toBe(0);
    expect(output).toContain('MCP will be off');
  });
});
