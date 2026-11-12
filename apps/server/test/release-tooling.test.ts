import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseNotesErrors, topReleaseVersion } from '../../../scripts/release/check-notes.mjs';
import {
  issuesForRelease,
  parseCloses,
  parseIssuesComment,
  previousTagFrom,
  prLimitWarning,
  readChangelogAtTag,
  resolvePreviousTag,
  selectReleasePullRequests,
} from '../../../scripts/release/close-issues.mjs';
import { missingPlatforms, platforms } from '../../../scripts/release/manifest-platforms.mjs';
import {
  bumpVersions,
  checkRelease,
  envKeys,
  findPreviousVersion,
  migrationsSince,
  missingEnvHistory,
  renderUpgradeBlock,
  updateEnvHistory,
  upgradeBlockOf,
  validateUpgradeBlock,
} from '../../../scripts/release/prepare.mjs';
import { assetProblems, expectedAssets } from '../../../scripts/release/release-assets.mjs';
import { isSemver, normalizeVersion } from '../../../scripts/release/semver.mjs';

// The release helpers (#521): the generated upgrade block, the version bump and the env-history
// source the test reads. Pure filesystem tests in the docs project.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'am-release-'));
  dirs.push(dir);
  return dir;
}

function put(root: string, path: string, text: string) {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function versionFixture() {
  const root = temp();
  for (const file of [
    'package.json',
    'apps/server/package.json',
    'apps/web/package.json',
    'packages/sdk-js/package.json',
    'packages/edge-worker/package.json',
  ]) {
    put(root, file, `${JSON.stringify({ name: file, version: '0.12.0' }, null, 2)}\n`);
  }
  put(root, 'deploy/helm/agentic-marketing/Chart.yaml', 'apiVersion: v2\nversion: 0.12.0\nappVersion: "0.12.0"\n');
  put(root, '.env.example', 'AM_VERSION=0.12.0\n');
  put(root, 'docker-compose.yml', `image: ghcr.io/timchr78/agentic-marketing:\${AM_VERSION:-0.12.0}\n`);
  put(root, 'README.md', '`AM_VERSION` (default `0.12.0`) selects the image. The current release is the **0.12** line.\n');
  return root;
}

describe('the release upgrade block', () => {
  it('lists migrations and variables, or says there are none', () => {
    const none = renderUpgradeBlock({ previous: '0.12.0', version: '0.13.0' });
    expect(none).toContain('### Upgrading from 0.12.0');
    expect(none).toContain('- **Migrations:** none.');
    expect(none).toContain('- **Configuration:** no new environment variables.');
    expect(none).toContain('- **Breaking changes:** TODO:');
    expect(none).toContain('- **Manual steps:** none.');
    expect(none).toContain('agentic-marketing-compose-0.13.0.tar.gz');
    expect(none).toContain('AM_VERSION=0.13.0 docker compose run');

    const some = renderUpgradeBlock({
      previous: '0.12.0',
      version: '0.13.0',
      migrations: ['0087_new.sql', '0088_other.sql'],
      envVars: ['NEW_SETTING'],
    });
    expect(some).toContain('`0087_new.sql`, `0088_other.sql`.');
    expect(some).toContain('`NEW_SETTING`.');
  });

  it('finds the previous release and the upgrade block in a section', () => {
    const changelog =
      '## [Unreleased]\n\n## [0.13.0] - 2026-11-08\n\n### Added\n\n- New.\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n\n## [0.12.0] - 2026-11-07\n';
    expect(findPreviousVersion(changelog)).toBe('0.13.0');
    expect(findPreviousVersion(changelog, '0.13.0')).toBe('0.12.0');
    expect(findPreviousVersion('## [Unreleased]\n\n## [0.12.0] - 2026-11-07\n')).toBe('0.12.0');
    const section = changelog.slice(changelog.indexOf('## [0.13.0]'), changelog.indexOf('## [0.12.0]'));
    expect(upgradeBlockOf(section)).toContain('### Upgrading from 0.12.0');
    expect(upgradeBlockOf(section)).toContain('- **Migrations:** none.');
  });
});

describe('the version bump', () => {
  it('updates every surface check-versions knows, plus the README default and release line', () => {
    const root = versionFixture();
    const changes = bumpVersions(root, '0.13.0');
    expect(changes).toContain('README.md');
    for (const file of [
      'package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'packages/sdk-js/package.json',
      'packages/edge-worker/package.json',
    ]) {
      expect(JSON.parse(readFileSync(join(root, file), 'utf8')).version).toBe('0.13.0');
    }
    expect(readFileSync(join(root, 'deploy/helm/agentic-marketing/Chart.yaml'), 'utf8')).toContain('version: 0.13.0');
    expect(readFileSync(join(root, 'deploy/helm/agentic-marketing/Chart.yaml'), 'utf8')).toContain('appVersion: "0.13.0"');
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toContain('AM_VERSION=0.13.0');
    expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toContain(`\${AM_VERSION:-0.13.0}`);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('`AM_VERSION` (default `0.13.0`)');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('current release is the **0.13** line');

    // Running it again is harmless, so a retried release does not change a second time.
    expect(bumpVersions(root, '0.13.0').length).toBe(changes.length);
  });
});

describe('the env-history source', () => {
  const source = `export const ENV_SINCE: Record<string, string> = {
  // 0.1.0
  AUTH_SECRET: '0.1.0',
  AM_VERSION: '0.1.1',
};
`;

  it('parses env keys including commented examples', () => {
    expect([...envKeys('A=1\n# B=2\n# a note\n')].sort()).toEqual(['A', 'B']);
  });

  it('records a new .env.example key at the release version and is idempotent', () => {
    const root = temp();
    put(root, 'apps/server/src/ops/env-history.ts', source);
    put(root, '.env.example', 'AUTH_SECRET=\nAM_VERSION=0.13.0\n# NEW_SETTING=on\n');
    expect(missingEnvHistory(root)).toEqual(['NEW_SETTING']);
    expect(updateEnvHistory(root, '0.13.0')).toEqual(['NEW_SETTING']);
    const updated = readFileSync(join(root, 'apps/server/src/ops/env-history.ts'), 'utf8');
    expect(updated).toContain("  // 0.13.0 (added by scripts/release/prepare.mjs)\n  NEW_SETTING: '0.13.0',");
    expect(missingEnvHistory(root)).toEqual([]);
    expect(updateEnvHistory(root, '0.13.0')).toEqual([]);
  });
});

describe('the release check', () => {
  it('refuses a TODO in the upgrade block and accepts a filled one', () => {
    const root = temp();
    put(
      root,
      'apps/server/src/ops/env-history.ts',
      "export const ENV_SINCE: Record<string, string> = {\n  AUTH_SECRET: '0.1.0',\n  AM_VERSION: '0.1.1',\n};\n",
    );
    put(root, '.env.example', 'AUTH_SECRET=\nAM_VERSION=0.13.0\n');
    const changelog = (breaking: string) =>
      `## [0.13.0] - 2026-11-08\n\n### Added\n\n- New.\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** ${breaking}\n- **Manual steps:** none.\n- **Upgrade:** pull.\n`;
    put(root, 'CHANGELOG.md', changelog('TODO: fill this in.'));
    expect(checkRelease({ root, version: '0.13.0' }).join('\n')).toMatch(/still contains TODO/);
    put(root, 'CHANGELOG.md', changelog('none.'));
    expect(checkRelease({ root, version: '0.13.0' })).toEqual([]);
  });
});

describe('closing issues', () => {
  it('reads Closes/Fixes/Resolves lines and the hidden fragment marker', () => {
    expect(parseCloses('Closes #1, #2\nFixes #3\nResolves #4')).toEqual([1, 2, 3, 4]);
    expect(parseCloses('No issue here.')).toEqual([]);
    expect(parseIssuesComment('## [0.13.0]\n\n<!-- issues: 3, 1, 3 -->')).toEqual([1, 3]);
    expect(parseIssuesComment('')).toEqual([]);
  });

  it('keeps only pull requests on the default branch inside the tag range', () => {
    const prs = [
      { number: 1, body: 'Closes #10', baseRefName: 'main', mergeCommit: { oid: 'in-main' } },
      { number: 2, body: 'Closes #20', baseRefName: 'phase/26', mergeCommit: { oid: 'in-phase' } },
      { number: 3, body: 'Closes #30', baseRefName: 'main', mergeCommit: { oid: 'after-release' } },
    ];
    expect(selectReleasePullRequests({ prs, commits: ['in-main', 'in-phase'], defaultBranch: 'main' }).map((pr) => pr.number)).toEqual([1]);
  });

  it('reads fragment issues from the tagged changelog, not the checkout', () => {
    const changelog = '## [0.13.0] - 2026-11-08\n\n### Added\n\n- New.\n\n<!-- issues: 42, 7 -->\n';
    expect(issuesForRelease({ prs: [{ number: 1, body: 'Closes #7\nFixes #9' }], changelog })).toEqual([7, 9, 42]);
    expect(
      readChangelogAtTag('0.13.0', (args) => {
        expect(args).toEqual(['show', 'v0.13.0:CHANGELOG.md']);
        return changelog;
      }),
    ).toBe(changelog);
  });
});

describe('the upgrade block validator', () => {
  const complete =
    '### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** none.\n- **Manual steps:** none.\n- **Upgrade:** pull.\n';

  it('accepts a complete block', () => {
    expect(validateUpgradeBlock(complete)).toEqual([]);
  });

  it('requires every field and a non-empty value', () => {
    expect(validateUpgradeBlock('### Upgrading from 0.12.0\n').join('\n')).toMatch(/missing "- \*\*Migrations:\*\*"/);
    expect(
      validateUpgradeBlock(
        '### Upgrading from 0.12.0\n\n- **Migrations:**\n- **Configuration:** none.\n- **Breaking changes:** none.\n- **Manual steps:** none.\n- **Upgrade:** pull.\n',
      ).join('\n'),
    ).toMatch(/empty "- \*\*Migrations:\*\*"/);
  });

  it('rejects a TODO', () => {
    expect(
      validateUpgradeBlock(complete.replace('- **Breaking changes:** none.', '- **Breaking changes:** TODO: fill this in.')).join('\n'),
    ).toMatch(/TODO/);
  });
});

describe('the release notes gate', () => {
  const section =
    '## [0.13.0] - 2026-11-08\n\n### Added\n\n- New.\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** none.\n- **Manual steps:** none.\n- **Upgrade:** pull.\n';

  it('accepts a complete top release and names it', () => {
    const changelog = `# Changelog\n\n## [Unreleased]\n\n${section}\n## [0.12.0] - 2026-11-07\n\n### Added\n\n- Old.\n`;
    expect(topReleaseVersion(changelog)).toBe('0.13.0');
    expect(releaseNotesErrors({ changelog, version: '0.13.0' })).toEqual([]);
  });

  it('reports an incomplete upgrade block', () => {
    const changelog = section.replace('- **Upgrade:** pull.\n', '');
    expect(releaseNotesErrors({ changelog, version: '0.13.0' }).join('\n')).toMatch(/missing "- \*\*Upgrade:\*\*"/);
  });
});

describe('manifest platforms', () => {
  it('requires the exact linux/amd64 and linux/arm64 pairs', () => {
    const manifest = {
      manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }, { platform: { os: 'windows', architecture: 'arm64' } }],
    };
    expect(platforms(manifest)).toEqual(['linux/amd64', 'windows/arm64']);
    expect(missingPlatforms(manifest)).toEqual(['linux/arm64']);
  });
});

describe('release assets', () => {
  const version = '0.13.0';
  const hash = (character: string) => character.repeat(64);

  it('requires the bundle, chart and SHA256SUMS with a checksum line for each', () => {
    const files = expectedAssets(version);
    const sums = `${hash('a')}  agentic-marketing-compose-${version}.tar.gz\n${hash('b')}  agentic-marketing-${version}.tgz\n`;
    expect(assetProblems({ version, files, sums })).toEqual([]);
    expect(assetProblems({ version, files: files.filter((file) => file !== `agentic-marketing-${version}.tgz`), sums })).toContain(
      `missing asset agentic-marketing-${version}.tgz`,
    );
    expect(assetProblems({ version, files, sums: sums.split('\n')[0] })).toContain(
      `SHA256SUMS has no checksum line for agentic-marketing-${version}.tgz`,
    );
  });
});

describe('previousTagFrom (#521 re-check)', () => {
  const tags = ['v0.1.0', 'v0.9.0', 'v0.10.0', 'v0.10.1', 'v0.11.0-rc.1', 'v0.11.0', 'v0.12.0', 'not-a-version'];
  it('finds the immediately preceding version by semver, not by listing order or paging', () => {
    expect(previousTagFrom(tags, '0.12.0')).toBe('v0.11.0');
    expect(previousTagFrom(tags, '0.11.0')).toBe('v0.11.0-rc.1');
    expect(previousTagFrom(tags, '0.11.0-rc.1')).toBe('v0.10.1');
    expect(previousTagFrom(tags, '0.10.0')).toBe('v0.9.0');
  });
  it('returns null only for a proven first release', () => {
    expect(previousTagFrom(tags, '0.1.0')).toBeNull();
  });
  it('refuses when the release tag is not present locally', () => {
    expect(() => previousTagFrom(tags, '0.13.0')).toThrow(/not in the local repository/);
  });
});

describe('the predecessor tag close-issues uses (#603)', () => {
  const tags = ['v0.13.0', 'v0.14.0', 'v0.14.1'];
  const changelog = '## [0.14.1] - 2026-11-09\n\n### Fixed\n\n- New.\n\n## [0.14.0] - 2026-11-01\n\n### Added\n\n- Old.\n';

  it('accepts an explicit previous version', () => {
    expect(resolvePreviousTag({ tags, version: '0.14.1', changelog, explicit: '0.14.0' })).toBe('v0.14.0');
    expect(resolvePreviousTag({ tags, version: '0.14.1', changelog, explicit: 'v0.14.0' })).toBe('v0.14.0');
  });

  it('takes the previous version from the CHANGELOG when none is given', () => {
    expect(resolvePreviousTag({ tags, version: '0.14.1', changelog })).toBe('v0.14.0');
  });

  it('fails instead of widening the range when the CHANGELOG predecessor tag is missing', () => {
    expect(() => resolvePreviousTag({ tags: ['v0.14.1'], version: '0.14.1', changelog })).toThrow(
      /v0\.14\.0 .*not in the local repository/,
    );
  });

  it('fails when an explicit previous tag is missing', () => {
    expect(() => resolvePreviousTag({ tags, version: '0.14.1', changelog, explicit: '0.13.1' })).toThrow(
      /v0\.13\.1 .*not in the local repository/,
    );
  });

  it('still fails when the release tag itself is missing', () => {
    expect(() => resolvePreviousTag({ tags: ['v0.13.0'], version: '0.14.1', changelog })).toThrow(
      /v0\.14\.1 .*not in the local repository/,
    );
  });

  it('warns when the merged pull request list hits its page limit', () => {
    expect(prLimitWarning(499)).toBeNull();
    expect(prLimitWarning(500)).toMatch(/500/);
    expect(prLimitWarning(500)).toMatch(/truncat|complete|more/i);
  });
});

describe('migrationsSince (#604)', () => {
  it('lists only migrations added in the range, not modified or deleted ones', () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'release@example.com');
    git('config', 'user.name', 'Release Test');
    git('config', 'commit.gpgsign', 'false');

    put(root, 'packages/db/migrations/0001_first.sql', 'select 1;\n');
    put(root, 'packages/db/migrations/0002_keep.sql', 'select 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('tag', 'v0.12.0');

    // Amend one migration and delete another: neither is new in this release.
    put(root, 'packages/db/migrations/0001_first.sql', 'select 10;\n');
    rmSync(join(root, 'packages/db/migrations/0002_keep.sql'));
    git('add', '-A');
    git('commit', '-q', '-m', 'edit');

    expect(migrationsSince(root, '0.12.0')).toEqual([]);

    put(root, 'packages/db/migrations/0003_new.sql', 'select 3;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add');

    expect(migrationsSince(root, '0.12.0')).toEqual(['packages/db/migrations/0003_new.sql']);
  });
});

describe('the release version check (#671)', () => {
  it('accepts every SemVer 2.0.0 form the release uses', () => {
    for (const version of ['0.14.10', '1.0.0-rc.1', '1.0.0+build.5', '1.0.0-rc.1+build.5', '0.0.0', '10.20.30']) {
      expect(isSemver(version), version).toBe(true);
    }
  });

  it('rejects a version that is not full SemVer 2.0.0', () => {
    for (const version of ['0.14.3-..', '01.2.3', '1.2', 'v1.2.3', '1.2.3-', '1.2.3+', '1.2.3.4', '1.2.3-01', '']) {
      expect(isSemver(version), version).toBe(false);
    }
  });

  it('normalises one leading v for both triggers, and refuses the rest', () => {
    expect(normalizeVersion('v0.14.10')).toBe('0.14.10');
    expect(normalizeVersion(' 0.14.10 ')).toBe('0.14.10');
    expect(normalizeVersion('0.14.3-..')).toBeNull();
    expect(normalizeVersion('')).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
  });

  it('is the entry point the workflow calls: it prints the version or exits 1', () => {
    const script = join(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts/release/semver.mjs');
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
    const run = (version: string) => {
      try {
        return { status: 0, stdout: execFileSync(process.execPath, [script, version], { encoding: 'utf8', stdio }) };
      } catch (error) {
        const failure = error as { status?: number; stderr?: string };
        return { status: failure.status, stdout: String(failure.stderr) };
      }
    };

    expect(run('v0.14.10')).toEqual({ status: 0, stdout: '0.14.10\n' });
    expect(run('0.14.3-..')).toMatchObject({ status: 1 });
    expect(run('0.14.3-..').stdout).toContain('::error::');
  });

  it('refuses a malformed version in a hand-run prepare (#671)', () => {
    const script = join(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts/release/prepare.mjs');
    let output = '';
    try {
      execFileSync(process.execPath, [script, '0.14.3-..', '--check'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    // The old parseArgs passed the version straight through; the shared check must refuse it first.
    expect(output).toMatch(/not a version: 0\.14\.3-\.\./);
  });
});

describe('the release workflow concurrency (#648)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start + 1);
    const body = rest.slice(rest.indexOf('\n') + 1);
    const next = body.search(/^ {2}[a-z][\w-]*:$/m);
    return next < 0 ? body : body.slice(0, next);
  };

  it('keys one job-level group on the normalised version instead of the raw trigger input', () => {
    expect(job('release')).toMatch(/concurrency:\n\s+group: release-v\$\{\{ needs\.prepare\.outputs\.version \}\}/);
    expect(workflow).not.toMatch(/group: release-\$\{\{ inputs\.version \|\| github\.ref_name \}\}/);
    expect(workflow).not.toMatch(/^concurrency:/m);
  });

  it('normalises a leading v for both a tag push and a manual run in one place', () => {
    const prepare = job('prepare');
    // Both triggers hand the raw ref or input to the script; it strips one leading v and validates
    // the full SemVer grammar, so `0.14.3-..` fails here, before anything is built (#671).
    expect(prepare).toMatch(/\$INPUT_VERSION/);
    expect(prepare).toMatch(/\$GITHUB_REF_NAME/);
    expect(prepare).toMatch(/node scripts\/release\/semver\.mjs/);
    expect(prepare).not.toMatch(/grep -Eq/);
    expect(prepare).toMatch(/outputs:\n\s+version: \$\{\{ steps\.version\.outputs\.version \}\}/);
  });
});
