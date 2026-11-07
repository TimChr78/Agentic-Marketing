import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Playwright-image wrapper runs on the host, not only in CI. These checks keep the review
// findings on #516 fixed without Docker in the test itself: ownership of the database and the
// process group, portable prerequisites, container detection, and the #515 run namespace.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

const [script, docs] = await Promise.all([read('scripts/e2e-docker.sh'), read('docs/development.md')]);

describe('e2e-docker prerequisites and portability', () => {
  it('parses with bash', () => {
    expect(() => execFileSync('bash', ['-n', join(root, 'scripts/e2e-docker.sh')], { stdio: 'pipe' })).not.toThrow();
  });

  it('does not need GNU date milliseconds', () => {
    // macOS date has no %3N; seconds and $RANDOM are enough for a unique run.
    expect(script).not.toMatch(/date \+%s%3N/);
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
});

describe('e2e-docker container network detection', () => {
  it('matches the hostname against container names and ids', () => {
    expect(script).toMatch(/--filter ["']?id=/);
    expect(script).toMatch(/--filter ["']?name=/);
  });

  it('reads the enclosing container id from proc when the hostname is custom', () => {
    expect(script).toMatch(/\/proc\/self\/(?:mountinfo|cgroup)/);
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

  it('keeps fresh-database and stale-server detection', () => {
    expect(script).toMatch(/MIN_SEED_SECONDS/);
    expect(script).toMatch(/db_database_exists "\$PG_DB"/);
    expect(script).toMatch(/db_has_seeded_workspace "\$PG_DB"/);
  });
});
