import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseNotesErrors, topReleaseVersion } from '../../../scripts/release/check-notes.mjs';
import {
  commitsInRange,
  issuesForRelease,
  parseCloses,
  parseIssuesComment,
  previousTagFrom,
  prLimitWarning,
  readChangelogAtTag,
  resolvePreviousTag,
  selectReleasePullRequests,
} from '../../../scripts/release/close-issues.mjs';
import { imageTagSpec, isNewestInLine, isNewestStable, parseTags } from '../../../scripts/release/image-tags.mjs';
import { missingPlatforms, platforms } from '../../../scripts/release/manifest-platforms.mjs';
import {
  architectureStatusVersions,
  assertCompleteHistory,
  bumpVersions,
  checkRelease,
  envKeys,
  findPreviousVersion,
  migrationsSince,
  missingEnvHistory,
  renderUpgradeBlock,
  statusProblems,
  updateEnvHistory,
  upgradeBlockOf,
  validateUpgradeBlock,
} from '../../../scripts/release/prepare.mjs';
import { assetProblems, expectedAssets } from '../../../scripts/release/release-assets.mjs';
import { isSemver, normalizeVersion, releaseLine } from '../../../scripts/release/semver.mjs';

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
  put(root, 'docs/architecture/README.md', '> Status: **0.x — release 0.12.0.** Waves 1–3 are built.\n');
  put(root, 'docs/architecture/overview.md', '> Status: describes **0.12.0**. Waves 1–3 are built.\n');
  put(root, 'docs/architecture/roadmap.md', 'Phases shipped. The current release is 0.12.0. The table is history.\n');
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
    // The architecture status lines are version surfaces too, so they cannot pin an old release
    // between releases (#784).
    expect(architectureStatusVersions(root).map((status) => status.version)).toEqual(['0.13.0', '0.13.0', '0.13.0']);

    // Running it again is harmless, so a retried release does not change a second time.
    expect(bumpVersions(root, '0.13.0').length).toBe(changes.length);
  });
});

describe('the architecture status lines (#784)', () => {
  it('fail a check when a page names an older release, and pass after the bump', () => {
    const root = versionFixture();
    const versions = () => architectureStatusVersions(root).map((status) => status.version);
    expect(versions()).toEqual(['0.12.0', '0.12.0', '0.12.0']);

    // check-versions compares each line with the release, so these three would be listed as
    // mismatches: the pages still pin the old release (#650's regression).
    expect(versions().filter((version) => version !== '0.13.0')).toHaveLength(3);

    bumpVersions(root, '0.13.0');
    expect(versions()).toEqual(['0.13.0', '0.13.0', '0.13.0']);

    // A reworded page loses its status line; that must be reported rather than pass silently.
    put(root, 'docs/architecture/overview.md', '> Status: rewritten without a release number.\n');
    expect(architectureStatusVersions(root)[1]).toEqual({ file: 'docs/architecture/overview.md', version: null });
  });

  it('reads a prerelease back after bumping to it (0.14.14 review)', () => {
    const root = versionFixture();
    bumpVersions(root, '1.0.0-rc.1');
    expect(architectureStatusVersions(root).map((status) => status.version)).toEqual(['1.0.0-rc.1', '1.0.0-rc.1', '1.0.0-rc.1']);
    bumpVersions(root, '1.0.0');
    expect(architectureStatusVersions(root).map((status) => status.version)).toEqual(['1.0.0', '1.0.0', '1.0.0']);
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
    put(
      root,
      'docs/status/current.md',
      `## Now\n\n- **0.13.0** (release tooling) is released and verified.\n\n## Last green\n\n- The last release is v0.13.0.\n`,
    );
    const changelog = (breaking: string) =>
      `## [0.13.0] - 2026-11-08\n\n### Added\n\n- New.\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** ${breaking}\n- **Manual steps:** none.\n- **Upgrade:** pull.\n`;
    put(root, 'CHANGELOG.md', changelog('TODO: fill this in.'));
    expect(checkRelease({ root, version: '0.13.0' }).join('\n')).toMatch(/still contains TODO/);
    put(root, 'CHANGELOG.md', changelog('none.'));
    expect(checkRelease({ root, version: '0.13.0' })).toEqual([]);
  });

  it('requires the handoff to name the release being cut (#785)', () => {
    const root = temp();
    put(
      root,
      'apps/server/src/ops/env-history.ts',
      "export const ENV_SINCE: Record<string, string> = {\n  AUTH_SECRET: '0.1.0',\n  AM_VERSION: '0.1.1',\n};\n",
    );
    put(root, '.env.example', 'AUTH_SECRET=\nAM_VERSION=0.13.0\n');
    put(
      root,
      'CHANGELOG.md',
      '## [0.13.0] - 2026-11-08\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** none.\n- **Manual steps:** none.\n- **Upgrade:** pull.\n',
    );

    expect(checkRelease({ root, version: '0.13.0' }).join('\n')).toMatch(/docs\/status\/current\.md is missing/);
    put(
      root,
      'docs/status/current.md',
      `## Now\n\n- **0.12.0** (previous) is released and verified.\n\n## Last green\n\n- The last release is v0.12.0.\n`,
    );
    expect(checkRelease({ root, version: '0.13.0' }).join('\n')).toMatch(/does not name \*\*0\.13\.0\*\*/);
    put(
      root,
      'docs/status/current.md',
      `## Now\n\n- **0.13.0** (release tooling) is being released.\n\n## Last green\n\n- The last release is v0.13.0.\n`,
    );
    expect(checkRelease({ root, version: '0.13.0' }).join('\n')).toMatch(/does not say 0\.13\.0 is released/);
    put(
      root,
      'docs/status/current.md',
      `## Now\n\n- **0.13.0** (release tooling) is released and verified.\n\n## Last green\n\n- The last release is v0.13.0.\n`,
    );
    expect(checkRelease({ root, version: '0.13.0' })).toEqual([]);
  });
});

describe('the release handoff gate (#785)', () => {
  it('reads the status file, not just the changelog', () => {
    const status = '## Now\n\n- **0.14.8** (alerts) is released and verified.\n\n## Last green\n\n- The last release is v0.14.8.\n';
    expect(statusProblems(status, '0.14.8')).toEqual([]);
    // 0.14.14 review: an unfinished state, a stale last release, or a mention outside "Now" fail.
    const now = (line: string, last = 'v0.14.8') => `## Now\n\n${line}\n\n## Last green\n\n- The last release is ${last}.\n`;
    expect(statusProblems(now('- **0.14.8** (alerts) is in progress.'), '0.14.8')[0]).toMatch(/does not say 0\.14\.8 is released/);
    expect(statusProblems(now('- **0.14.8** (alerts) is not released.'), '0.14.8')[0]).toMatch(/does not say 0\.14\.8 is released/);
    expect(statusProblems(now('- **0.14.8** (alerts) is unreleased.'), '0.14.8')[0]).toMatch(/does not say 0\.14\.8 is released/);
    expect(statusProblems(now('- **0.14.8** (alerts) is released.', 'v0.14.7'), '0.14.8')[0]).toMatch(/last release/);
    expect(
      statusProblems(
        '## Now\n\n- Nothing.\n\n## History\n\n- **0.14.8** is released.\n\n## Last green\n\n- The last release is v0.14.8.\n',
        '0.14.8',
      )[0],
    ).toMatch(/does not name \*\*0\.14\.8\*\*/);
    expect(statusProblems(status, '0.14.9')[0]).toMatch(/does not name \*\*0\.14\.9\*\*/);
    expect(statusProblems(now('- **0.14.8** (alerts) is being released.'), '0.14.8')[0]).toMatch(/does not say 0\.14\.8 is released/);
    expect(statusProblems(null, '0.14.8')[0]).toMatch(/is missing/);
  });

  it('fails the release-notes gate the workflow runs, before publishing', () => {
    const changelog =
      '## [0.13.0] - 2026-11-08\n\n### Upgrading from 0.12.0\n\n- **Migrations:** none.\n- **Configuration:** no new environment variables.\n- **Breaking changes:** none.\n- **Manual steps:** none.\n- **Upgrade:** pull.\n';
    expect(
      releaseNotesErrors({
        changelog,
        version: '0.13.0',
        status: `## Now\n\n- **0.13.0** is released.\n\n## Last green\n\n- The last release is v0.13.0.\n`,
      }),
    ).toEqual([]);
    expect(
      releaseNotesErrors({
        changelog,
        version: '0.13.0',
        status: `## Now\n\n- **0.13.0** is being released.\n\n## Last green\n\n- The last release is v0.13.0.\n`,
      }),
    ).toEqual(['docs/status/current.md does not say 0.13.0 is released in its "Now" state; mark it released before the release']);
    // Without a status argument the changelog-only tests keep working.
    expect(releaseNotesErrors({ changelog, version: '0.13.0' })).toEqual([]);
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

describe('shallow clones (#772)', () => {
  /** A repository with two tags and commits between them. */
  function historyRepo(): string {
    const dir = temp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'release@example.com');
    git('config', 'user.name', 'Release Test');
    git('config', 'commit.gpgsign', 'false');
    put(dir, 'packages/db/migrations/0001_base.sql', 'select 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('tag', 'v0.12.0');
    put(dir, 'packages/db/migrations/0002_new.sql', 'select 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    put(dir, 'README.md', 'release\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    git('tag', 'v0.12.1');
    return dir;
  }

  it('refuses a shallow clone instead of silently truncating the tag range', () => {
    const origin = historyRepo();
    const clone = temp();
    // file:// forces the smart protocol, which honours --depth (a plain path does not).
    execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${origin}`, clone]);
    execFileSync('git', ['fetch', '--quiet', '--tags', '--force'], { cwd: clone });

    // Both release scripts read a tag range: prepare for migrations, close-issues for the
    // release's commit list. Both must refuse before the truncated answer reaches the changelog.
    expect(() => assertCompleteHistory(clone)).toThrow(/shallow clone[\s\S]*--unshallow/);
    expect(() => migrationsSince(clone, '0.12.0')).toThrow(/shallow clone/);
    expect(() => commitsInRange(clone, 'v0.12.0', '0.12.1')).toThrow(/shallow clone/);

    // A complete clone has the history, so the same calls work there.
    expect(assertCompleteHistory(origin)).toBeUndefined();
    expect(commitsInRange(origin, 'v0.12.0', '0.12.1')).toHaveLength(2);
    expect(migrationsSince(origin, '0.12.0')).toEqual(['packages/db/migrations/0002_new.sql']);
  });
});

describe('the floating major.minor image tag (#773)', () => {
  it('moves only for the newest release in its line', () => {
    const spec = (version: string, tags: string[]) => imageTagSpec(version, tags);
    expect(spec('0.14.8', ['v0.14.5', 'v0.14.8'])).toContain('type=semver,pattern={{major}}.{{minor}}');
    // An older patch finishing later must not move :0.14 backwards.
    expect(spec('0.14.5', ['v0.14.5', 'v0.14.8'])).toBe('type=semver,pattern={{version}},value=0.14.5');
    // Another line never blocks, and this version's own tag (a tag push) is not "newer".
    expect(spec('0.14.9', ['v0.14.9', 'v0.15.0'])).toContain('{{major}}.{{minor}}');
    expect(spec('0.14.9', ['v0.14.9', 'v0.14.10'])).not.toContain('{{major}}.{{minor}}');
    // A prerelease is older than its release in semver order.
    expect(spec('0.14.9-rc.1', ['v0.14.9'])).not.toContain('{{major}}.{{minor}}');
    expect(isNewestInLine('0.14.10', ['v0.14.9', 'v0.14.2'])).toBe(true);
    expect(isNewestInLine('0.14.2', ['v0.14.10'])).toBe(false);
  });

  it('publishes latest only for the newest stable release of all lines (0.14.14 review)', () => {
    // An older patch retried after a newer release must not move latest.
    expect(imageTagSpec('0.14.13', ['v0.14.13', 'v0.14.14'])).not.toContain('latest');
    expect(imageTagSpec('0.14.14', ['v0.14.13', 'v0.14.14'])).toContain('type=raw,value=latest');
    // The newest patch of an older line moves its line tag but not latest.
    expect(imageTagSpec('0.13.9', ['v0.13.8', 'v0.14.2'])).toContain('{{major}}.{{minor}}');
    expect(imageTagSpec('0.13.9', ['v0.13.8', 'v0.14.2'])).not.toContain('latest');
    // A prerelease never becomes latest, and a newer prerelease does not block a release.
    expect(imageTagSpec('0.15.0-rc.1', ['v0.14.14'])).not.toContain('latest');
    expect(imageTagSpec('0.14.14', ['v0.15.0-rc.1'])).toContain('type=raw,value=latest');
    expect(imageTagSpec('0.14.9', [], { exactOnly: true })).not.toContain('latest');
  });

  it('ignores prereleases and non-SemVer tags when moving the floating tags (0.14.14 review round 2)', () => {
    // A newer prerelease in the line does not hold :0.14 back; a prerelease never moves it.
    expect(imageTagSpec('0.14.14', ['v0.14.13', 'v0.14.15-rc.1'])).toContain('{{major}}.{{minor}}');
    expect(imageTagSpec('0.14.15-rc.1', ['v0.14.14'])).not.toContain('{{major}}.{{minor}}');
    // An invalid tag (leading zeros) is not a release and blocks nothing.
    expect(isNewestStable('0.14.14', ['v99.00.0'])).toBe(true);
    expect(imageTagSpec('0.14.14', ['v99.00.0', 'vnext'])).toContain('type=raw,value=latest');
  });

  it('publishes the exact tag alone when the line cannot be read', () => {
    expect(imageTagSpec('0.14.9', [], { exactOnly: true })).toBe('type=semver,pattern={{version}},value=0.14.9');
    expect(parseTags('# comment\nv0.14.1\n\nv0.14.2\n')).toEqual(['v0.14.1', 'v0.14.2']);
  });

  it('derives the line from the version for the concurrency group', () => {
    expect(releaseLine('0.14.8')).toBe('0.14');
    expect(releaseLine('0.15.0-rc.1')).toBe('0.15');
    expect(releaseLine('10.20.30')).toBe('10.20');
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

describe('workflow shell steps parse (0.14.14 review round 4)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  /** Every `run:` script of a workflow, with GitHub expressions replaced by a placeholder. */
  const runScripts = (file: string) => {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    const scripts: { line: number; body: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
      if (!m) continue;
      const indent = m[1]!.length;
      let body = m[2]!;
      if (body === '|' || body === '>') {
        const block: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]!;
          if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
          block.push(l);
        }
        body = block.join('\n');
      }
      scripts.push({ line: i + 1, body: body.replace(/\$\{\{[^}]*\}\}/g, 'X') });
    }
    return scripts;
  };

  for (const file of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
    it(`every run step in ${file} is valid bash`, () => {
      const scripts = runScripts(file);
      expect(scripts.length).toBeGreaterThan(3);
      for (const { line, body } of scripts) {
        const result = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
        expect(result.status, `${file}:${line}: ${result.stderr}`).toBe(0);
      }
    });
  }
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

  it('queues every release in one job-level group instead of the raw trigger input', () => {
    // One group for all lines, not one per line: latest spans lines, so two lines publishing at
    // once could both decide they are newest (#773, 0.14.14 review round 2).
    expect(job('release')).toMatch(/concurrency:\n\s+group: release\n/);
    expect(job('release')).toMatch(/cancel-in-progress: false/);
    expect(workflow).not.toMatch(/group: release-\$\{\{ inputs\.version \|\| github\.ref_name \}\}/);
    expect(workflow).not.toMatch(/^concurrency:/m);
    // The prepare job derives that line with the tested semver helper, not a bash expression.
    expect(job('prepare')).toMatch(/semver\.mjs "\$raw" --line/);
    expect(job('prepare')).toMatch(
      /outputs:\n\s+version: \$\{\{ steps\.version\.outputs\.version \}\}\n\s+line: \$\{\{ steps\.version\.outputs\.line \}\}/,
    );
  });

  it('guards the floating tag with the tested image-tags script', () => {
    expect(job('release')).toContain('scripts/release/image-tags.mjs');
    expect(job('release')).toMatch(/tags: \$\{\{ steps\.tags\.outputs\.spec \}\}/);
    // The old static tag list let every patch move the line tag.
    expect(job('release')).not.toMatch(/tags: \|\n\s+type=semver,pattern=\{\{version\}\}/);
  });

  it("turns off the metadata action's automatic latest tag", () => {
    expect(job('release')).toMatch(/flavor: \|?\s*\n?\s*latest=false/);
    // Every tag is listed, so latest can be compared across lines.
    expect(job('release')).toMatch(/matching-refs\/tags\/v"/);
  });

  it('queues every pending release instead of replacing the waiting one (0.14.14 review round 3)', () => {
    expect(job('release')).toMatch(/concurrency:\n\s+group: release\n\s+cancel-in-progress: false\n\s+queue: max/);
    // The CI a release calls gets its own group, so two manual releases from main never share one.
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(
      /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.workflow == 'Release' && github\.run_id \|\| github\.ref \}\}/,
    );
  });

  it('reserves the version tag before any image is pushed (0.14.14 review round 3)', () => {
    const release = job('release');
    const reserve = release.indexOf('name: Reserve the version tag');
    expect(reserve).toBeGreaterThan(0);
    // Before the tag decision and the first push, so an older retry always sees this version.
    expect(reserve).toBeLessThan(release.indexOf('name: Decide the image tags'));
    expect(release.slice(reserve)).toMatch(/git\/refs/);
    // A manual retry is allowed only when the existing tag points at the same commit.
    expect(release).toMatch(/points at \$existing, not \$sha/);
    expect(release).not.toMatch(/Tag v\$v exists already: push it again/);
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
