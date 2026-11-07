import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseNotesErrors, topReleaseVersion } from '../../../scripts/release/check-notes.mjs';
import {
  issuesForRelease,
  parseCloses,
  parseIssuesComment,
  readChangelogAtTag,
  selectReleasePullRequests,
} from '../../../scripts/release/close-issues.mjs';
import { missingPlatforms, platforms } from '../../../scripts/release/manifest-platforms.mjs';
import {
  bumpVersions,
  checkRelease,
  envKeys,
  findPreviousVersion,
  missingEnvHistory,
  renderUpgradeBlock,
  updateEnvHistory,
  upgradeBlockOf,
  validateUpgradeBlock,
} from '../../../scripts/release/prepare.mjs';
import { assetProblems, expectedAssets } from '../../../scripts/release/release-assets.mjs';

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
