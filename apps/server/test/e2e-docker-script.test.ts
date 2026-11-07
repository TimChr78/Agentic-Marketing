import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Playwright-image wrapper runs on the host, not only in CI. These checks keep the review
// findings on #516 fixed without Docker in the test itself: ownership of the database and the
// process group, portable prerequisites, container detection, and the #515 run namespace.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');
const scriptPath = join(root, 'scripts/e2e-docker.sh');
const containerLibPath = join(root, 'scripts/container-id.sh');

const [script, docs, containerLib] = await Promise.all([
  read('scripts/e2e-docker.sh'),
  read('docs/development.md'),
  read('scripts/container-id.sh'),
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Match scripts/e2e-docker.sh: /tmp/opencode when it is writable, else $TMPDIR or /tmp.
const TMP_ROOT = (() => {
  try {
    accessSync('/tmp/opencode', constants.W_OK);
    return '/tmp/opencode';
  } catch {
    return process.env.TMPDIR || tmpdir();
  }
})();

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(TMP_ROOT, `${prefix}-`));
}

async function writeShim(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return file;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(check: () => Promise<T | false> | T | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== false) return value;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

interface WrapperRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

function spawnWrapper(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000) {
  const child = spawn('bash', [scriptPath, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<WrapperRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wrapper did not exit within ${timeoutMs}ms\n${output}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
  return { child, exited, output: () => output };
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<WrapperRun> {
  return spawnWrapper(args, env, timeoutMs).exited;
}

function databaseExists(name: string): boolean {
  const out = execFileSync(
    'node',
    [
      '-e',
      `const { Client } = require("pg");
const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = "/postgres";
const client = new Client({ connectionString: url.toString() });
(async () => {
  await client.connect();
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [process.env.DBNAME]);
  await client.end();
  console.log(result.rowCount ? "1" : "0");
})().catch((error) => { console.error(error.message); process.exit(2); });`,
    ],
    { cwd: join(root, 'apps/server'), env: { ...process.env, DBNAME: name }, encoding: 'utf8' },
  );
  return out.trim() === '1';
}

function dropDatabase(name: string): void {
  execFileSync(
    'node',
    [
      '-e',
      `const { Client } = require("pg");
const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = "/postgres";
const client = new Client({ connectionString: url.toString() });
(async () => {
  await client.connect();
  await client.query('DROP DATABASE IF EXISTS "' + process.env.DBNAME + '" WITH (FORCE)');
  await client.end();
})().catch((error) => { console.error(error.message); process.exit(2); });`,
    ],
    { cwd: join(root, 'apps/server'), env: { ...process.env, DBNAME: name }, encoding: 'utf8' },
  );
}

function pidFilesFor(run: string): Promise<string[]> {
  return readdir(TMP_ROOT).then((files) => files.filter((file) => file.startsWith(`e2e-pgid-${run}-`)));
}

describe('e2e-docker prerequisites and portability', () => {
  it('parses with bash', () => {
    expect(() => execFileSync('bash', ['-n', join(root, 'scripts/e2e-docker.sh')], { stdio: 'pipe' })).not.toThrow();
  });

  it('does not need GNU date milliseconds', () => {
    // macOS date has no %3N; seconds and $RANDOM are enough for a unique run.
    expect(script).not.toMatch(/date \+%s%3N/);
  });

  it('hands files back only after Playwright ran, so cleanup never pulls the image', () => {
    const fn = script.slice(script.indexOf('restore_ownership() {'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/PLAYWRIGHT_RAN:-0\}" = "1" \] \|\| return 0/);
    expect(script.indexOf('PLAYWRIGHT_RAN=1')).toBeLessThan(script.indexOf('if ! docker run --rm --init'));
  });

  it('fails fast without setsid before installing a trap', () => {
    const setsidCheck = script.search(/command -v setsid/);
    const trap = script.search(/trap cleanup EXIT/);
    expect(setsidCheck).toBeGreaterThanOrEqual(0);
    expect(trap).toBeGreaterThan(setsidCheck);
    expect(script).toMatch(/setsid[^\n]*(?:required|requires|missing)|(?:required|requires|missing)[^\n]*setsid/i);
  });

  it('documents Linux as the target for the browser suite', () => {
    expect(docs).toMatch(/Linux/);
    expect(docs).toMatch(/setsid/);
  });
});

describe('e2e-docker database ownership', () => {
  it('generates its own database name and refuses an explicit name that exists', () => {
    expect(script).toMatch(/E2E_DB/);
    expect(script).toMatch(/already exists[^\n]*refus|refus[^\n]*already exists/i);
    expect(script).toMatch(/db_database_exists "\$PG_DB"/);
  });

  it('computes the database name with print-db under this run namespace', () => {
    expect(script).toMatch(/print-db\.ts/);
    expect(script).toMatch(/AM_TEST_RUN/);
  });

  it('records ownership only after the seeded database was checked', () => {
    const seeded = script.indexOf('db_has_seeded_workspace "$PG_DB"');
    const owned = script.indexOf('DB_OWNED=1');
    expect(seeded).toBeGreaterThanOrEqual(0);
    expect(owned).toBeGreaterThan(seeded);
    // The cleanup never drops a database it did not own.
    expect(script).not.toMatch(/elif \[ -n "\$DB_NAME" \][^\n]*db_drop/);
    expect(script).toMatch(/DB_OWNED/);
  });
});

describe('e2e-docker process group ownership', () => {
  it('has the child write its own PGID and verifies it is a private leader', () => {
    expect(script).toMatch(/PGID_FILE/);
    expect(script).toMatch(/ps -o pgid=/);
    expect(script).toMatch(/CALLER_PGID/);
    expect(script).toMatch(/refusing/i);
  });

  it('refuses to signal the caller’s process group', () => {
    const guard = script.search(/SERVER_PGID[^\n]*CALLER_PGID|CALLER_PGID[^\n]*SERVER_PGID/);
    expect(guard).toBeGreaterThanOrEqual(0);
  });

  it('records the launched pid before the handshake completes', () => {
    expect(script).toMatch(/LAUNCHED_PID=\$!/);
    expect(script).toMatch(/LAUNCHED_PID/);
  });

  it('removes the PID file on every exit path', () => {
    expect(script).toMatch(/rm -f "\$PGID_FILE"/);
  });
});

describe('e2e-docker container network detection', () => {
  it('matches the hostname against container names and ids', () => {
    expect(script).toMatch(/--filter ["']?id=/);
    expect(script).toMatch(/--filter ["']?name=/);
  });

  it('reads the enclosing container id from proc when the hostname is custom', () => {
    expect(containerLib).toMatch(/\/proc\/self\/(?:mountinfo|cgroup)/);
    // /containers/<id> (Docker mountinfo), /docker/<id> (cgroup v1) and docker-<id>.scope.
    expect(containerLib).toMatch(/containers\//);
    expect(containerLib).toMatch(/docker\[-\/\]/);
  });

  it('fails with E2E_DOCKER_NETWORK instead of silently using host networking', () => {
    expect(script).toMatch(/E2E_DOCKER_NETWORK/);
    // The only host default is the not-inside-a-container branch.
    const fallback = script.search(/NETWORK="host"/g);
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(script).not.toMatch(/failed to resolve[^\n]*NETWORK="host"/i);
  });
});

describe('e2e-docker follows the #515 shared stack', () => {
  it('exports one AM_TEST_RUN for the whole invocation', () => {
    expect(script).toMatch(/AM_TEST_RUN="\$\{AM_TEST_RUN:-/);
    expect(script).toMatch(/export AM_TEST_RUN/);
  });

  it('takes the port offset from e2e/ports.ts', () => {
    expect(script).toMatch(/e2e\/ports\.ts/);
    expect(script).toMatch(/TEST_PORT_OFFSET/);
  });

  it('keeps Playwright artifacts in a run-scoped output directory', () => {
    // Two concurrent runs share the mounted checkout; a fixed test-results/ made them delete each
    // other's traces.
    expect(script).toMatch(/--output/);
    expect(script).toMatch(/OUTPUT_DIR="test-results\/\$AM_TEST_RUN"/);
  });

  it('keeps fresh-database and stale-server detection', () => {
    expect(script).toMatch(/MIN_SEED_SECONDS/);
    expect(script).toMatch(/db_database_exists "\$PG_DB"/);
    expect(script).toMatch(/db_has_seeded_workspace "\$PG_DB"/);
  });
});

describe('container id parser', () => {
  const id = '0123456789abcdef'.repeat(4);
  const unrelated = 'fedcba9876543210'.repeat(4);

  function parse(text: string): string {
    return execFileSync('bash', ['-c', `set -euo pipefail; . "${containerLibPath}"; container_id_from_text`], {
      input: `${text}\n`,
      encoding: 'utf8',
    }).trim();
  }

  it.each([
    ['Docker mountinfo /containers/<id>/', `/containers/${id}/hostname /etc/hostname rw - overlay overlay`],
    ['Docker mountinfo /docker/containers/<id>/', `/docker/containers/${id}/hostname /etc/hostname rw - overlay overlay`],
    ['cgroup v1 /docker/<id>', `12:devices:/docker/${id}`],
    ['systemd scope docker-<id>.scope', `0::/system.slice/docker-${id}.scope`],
    ['containerd path containerd-<id>', `/run/containerd/containerd-${id}/root`],
  ])('finds the id in %s', (_name, line) => {
    expect(parse(line)).toBe(id);
  });

  it('ignores an unrelated 64-hex id before a real container path', () => {
    expect(parse(`lowerdir=/var/lib/overlay/${unrelated}/diff /containers/${id}/hostname`)).toBe(id);
  });

  it('returns nothing when no runtime marker precedes an id', () => {
    expect(parse(`/var/lib/overlay/${unrelated}/diff`)).toBe('');
  });

  it('resolves this host container id from mountinfo or cgroup', () => {
    if (!existsSync('/.dockerenv')) return;
    const hostId = execFileSync('bash', ['-c', `. "${containerLibPath}"; container_id_from_proc`], {
      encoding: 'utf8',
    }).trim();
    expect(hostId).toMatch(/^[0-9a-f]{64}$/);
    const names = execFileSync('docker', ['ps', '--filter', `id=${hostId}`, '--format', '{{.Names}}'], {
      encoding: 'utf8',
    }).trim();
    expect(names).not.toBe('');
    const hostname = process.env.HOSTNAME ?? '';
    if (/^[0-9a-f]{12,}$/.test(hostname)) expect(hostId.startsWith(hostname)).toBe(true);
  });
});

describe('e2e-docker server lifecycle', () => {
  const handshakeEnv = async (run: string) => {
    const bin = await tempDir(`e2e-bin-${run}`);
    const childFile = join(bin, 'child.pid');
    await writeShim(bin, 'setsid', `#!/usr/bin/env bash\nprintf '%s\\n' "$$" > "$E2E_TEST_CHILD_PID_FILE"\nexec sleep 120\n`);
    return {
      bin,
      childFile,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        E2E_TEST_CHILD_PID_FILE: childFile,
        E2E_SKIP_BUILD: '1',
        E2E_DOCKER_NETWORK: 'host',
        CHROMIUM: '/bin/true',
        E2E_PORT: String(await freePort()),
        AM_TEST_RUN: run,
      } satisfies NodeJS.ProcessEnv,
    };
  };

  const launchedPid = (file: string) =>
    waitFor(async () => {
      try {
        const pid = Number((await readFile(file, 'utf8')).trim());
        return Number.isInteger(pid) && pid > 0 ? pid : false;
      } catch {
        return false;
      }
    });

  const stopLeftovers = async (bin: string, pid: number | undefined, run: string) => {
    if (pid !== undefined && processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    for (const file of await pidFilesFor(run)) await rm(join(TMP_ROOT, file), { force: true });
    await rm(bin, { recursive: true, force: true });
  };

  it('stops the launched child when cancelled during the PID handshake', async () => {
    const run = `cancel${Date.now().toString(36)}`.slice(0, 16);
    const { bin, childFile, env } = await handshakeEnv(run);
    const wrapper = spawnWrapper(['smoke'], env, 30_000);
    let pid: number | undefined;
    try {
      pid = await launchedPid(childFile);
      wrapper.child.kill('SIGTERM');
      const result = await wrapper.exited;
      expect(result.code, result.output).toBe(130);
      const stopped = await waitFor(() => (processAlive(pid!) ? false : ('stopped' as const)), 5_000).catch(() => 'running' as const);
      expect(stopped, `child ${pid} survived TERM during the handshake\n${result.output}`).toBe('stopped');
      expect(await pidFilesFor(run), 'PID file left behind').toEqual([]);
    } finally {
      await stopLeftovers(bin, pid, run);
    }
  }, 40_000);

  it('stops the launched child when the PID handshake times out', async () => {
    const run = `timeout${Date.now().toString(36)}`.slice(0, 16);
    const { bin, childFile, env } = await handshakeEnv(run);
    let pid: number | undefined;
    try {
      const wrapper = spawnWrapper(['smoke'], env, 40_000);
      pid = await launchedPid(childFile);
      const result = await wrapper.exited;
      expect(result.code, result.output).toBe(1);
      expect(result.output).toMatch(/did not report its process group/);
      const stopped = await waitFor(() => (processAlive(pid!) ? false : ('stopped' as const)), 5_000).catch(() => 'running' as const);
      expect(stopped, `child ${pid} survived the handshake timeout\n${result.output}`).toBe('stopped');
      expect(await pidFilesFor(run), 'PID file left behind').toEqual([]);
    } finally {
      await stopLeftovers(bin, pid, run);
    }
  }, 50_000);

  it('drops an explicitly named database when the seed fails after creating it', async () => {
    const run = `seedfail${Date.now().toString(36)}`.slice(0, 16);
    const home = await tempDir(`e2e-home-${run}`);
    const bin = join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    const marker = join(home, 'seed-created');
    await writeShim(bin, 'pnpm', '#!/usr/bin/env bash\nexit 0\n');
    await writeShim(
      bin,
      'npx',
      `#!/usr/bin/env bash
set -euo pipefail
PG_DB="$(node --import tsx packages/db/test/print-db.ts "am_\${E2E_DB}")"
cd apps/server
DBNAME="$PG_DB" node -e 'const { Client } = require("pg");
const url = new URL(process.env.TEST_DATABASE_URL);
url.pathname = "/postgres";
const client = new Client({ connectionString: url.toString() });
(async () => {
  await client.connect();
  await client.query("CREATE DATABASE \\"" + process.env.DBNAME + "\\"");
  await client.end();
})().catch((error) => { console.error(error.message); process.exit(2); });'
printf 'created\\n' > "$E2E_TEST_SEED_MARKER"
echo "simulated seed failure" >&2
exit 1
`,
    );
    const env = {
      ...process.env,
      HOME: home,
      E2E_TEST_SEED_MARKER: marker,
      E2E_SKIP_BUILD: '1',
      E2E_DOCKER_NETWORK: 'host',
      CHROMIUM: '/bin/true',
      E2E_PORT: String(await freePort()),
      AM_TEST_RUN: run,
      E2E_DB: 'e2e_failseed',
    } satisfies NodeJS.ProcessEnv;
    const pgDb = execFileSync('node', ['--import', 'tsx', 'packages/db/test/print-db.ts', 'am_e2e_failseed'], {
      cwd: root,
      env: { ...process.env, AM_TEST_RUN: run },
      encoding: 'utf8',
    }).trim();
    try {
      dropDatabase(pgDb);
      const result = await runWrapper(['smoke'], env, 40_000);
      expect(existsSync(marker), `the fake seed did not create ${pgDb}\n${result.output}`).toBe(true);
      expect(result.code, result.output).toBe(1);
      expect(databaseExists(pgDb), `explicit database ${pgDb} leaked after a failed seed`).toBe(false);
      expect(await pidFilesFor(run), 'PID file left behind').toEqual([]);
    } finally {
      dropDatabase(pgDb);
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
