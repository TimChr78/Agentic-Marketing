import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The shared test stack scripts run on the host, not only in CI. These checks keep the
// portability and port-probe review findings fixed without Docker in the test itself.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

const [clean, preflight, services, docs] = await Promise.all([
  read('scripts/docker-clean.sh'),
  read('scripts/preflight.sh'),
  read('scripts/test-services.sh'),
  read('docs/development.md'),
]);

describe('test stack script portability', () => {
  it('parses with bash and does not require mapfile (stock macOS bash 3.2 lacks it)', () => {
    for (const script of ['scripts/docker-clean.sh', 'scripts/preflight.sh', 'scripts/test-services.sh']) {
      expect(() => execFileSync('bash', ['-n', join(root, script)], { stdio: 'pipe' })).not.toThrow();
    }
    expect(clean).not.toMatch(/\bmapfile\b/);
  });

  it('refuses to run without the GNU tools and bash it needs, with a clear message', () => {
    for (const script of [clean, preflight, services]) {
      expect(script).toMatch(/BASH_VERSINFO/);
      expect(script).toMatch(/bash (?:>=|≥|4)/i);
    }
    // docker-clean's size probe pipes through timeout; macOS gets it as gtimeout.
    expect(clean).toMatch(/gtimeout|coreutils/);
  });

  it('documents the Linux target and what macOS needs', () => {
    expect(docs).toMatch(/Linux/);
    expect(docs).toMatch(/macOS[^\n]*coreutils[^\n]*bash 5|macOS[^\n]*bash 5[^\n]*coreutils/i);
  });
});

describe('preflight port probing', () => {
  it('probes the host namespace first with ss or /proc/net/tcp', () => {
    expect(preflight).toMatch(/\bss\b/);
    expect(preflight).toMatch(/\/proc\/net\/tcp/);
  });

  it('never reports success when it could not establish port availability', () => {
    // The old fallback passed every port that Docker did not publish, even when nothing was probed.
    expect(preflight).not.toMatch(/checking Docker publishers only/);
    expect(preflight).toMatch(/AM_TEST_ALLOW_UNVERIFIED_PORTS/);
    expect(preflight).toMatch(/UNKNOWN/);
    expect(preflight).toMatch(/cannot (?:probe|verify|establish)/i);
  });
});
