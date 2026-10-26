import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';

// Spawn the real CLI the way an operator does, with no configuration at all. The cwd is a temp
// directory so cli.ts cannot load the checkout's .env; tsx is resolved to an absolute path
// because a bare `--import tsx` only resolves when the cwd is inside the repository.
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');

async function am(args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', loader, '--', cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const error = err as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('am without configuration', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'am-cli-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints general help for --help, help and no arguments', async () => {
    for (const args of [['--help'], ['help'], []]) {
      const result = await am(args, dir);
      expect(result.code, JSON.stringify(args)).toBe(0);
      expect(result.stdout).toContain('usage: am <command>');
      for (const command of ['migrate', 'bootstrap', 'reset-password', 'rotate-keys', 'loadtest', 'doctor']) {
        expect(result.stdout, command).toContain(command);
      }
      expect(result.stderr).toBe('');
    }
  });

  it('prints command help without loading configuration', async () => {
    const doctor = await am(['doctor', '--help'], dir);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('usage: am doctor');
    expect(doctor.stdout).toContain('--env-file');

    const init = await am(['init', '--help'], dir);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('usage: am init');

    const backup = await am(['backup', '--help'], dir);
    expect(backup.code).toBe(0);
    expect(backup.stdout).toContain('usage: am backup');
  });

  it('prints the version', async () => {
    const result = await am(['version'], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(VERSION);
  });

  it('prints a short configuration error without a stack trace', async () => {
    const result = await am(['migrate'], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Configuration is incomplete:');
    expect(result.stderr).toContain('DATABASE_URL is missing');
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toContain('ConfigError');
  });

  it('rejects an unknown command with a short hint', async () => {
    const result = await am(['nonsense'], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown command');
    expect(result.stdout).toContain('usage: am <command>');
  });
});
