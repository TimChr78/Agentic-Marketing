import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build, check, checkFragments, parseFragment, readFragments, renderSection } from '../../../scripts/changelog.mjs';

// The fragment format and the one-pass build (#521). These are pure filesystem tests, so they run
// in the docs project without the service stack.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(changelog: string, fragments: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'am-changelog-'));
  dirs.push(dir);
  const fragmentDir = join(dir, 'changelog.d');
  mkdirSync(fragmentDir);
  const changelogPath = join(dir, 'CHANGELOG.md');
  writeFileSync(changelogPath, changelog);
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(fragmentDir, name), text);
  return { dir, fragmentDir, changelogPath };
}

function fragment(section: string, issues: number[], text: string) {
  return `---\nsection: ${section}\nissues: [${issues.join(', ')}]\n---\n${text}\n`;
}

const base = `# Changelog

Intro.

## [Unreleased]

### Changed

- Unreleased change.

## [0.12.0] - 2026-11-07

### Added

- Previous release.
`;

describe('changelog fragments', () => {
  it('accepts a valid fragment and rejects a bad section, empty text and duplicate file names', () => {
    const valid = workspace(base, { '7-added.md': fragment('Added', [7], '- A valid change.') });
    expect(check(valid.fragmentDir).errors).toEqual([]);
    expect(readFragments(valid.fragmentDir).map((item) => item.name)).toEqual(['7-added.md']);

    const bad = workspace(base, {
      '7-added.md': fragment('Nope', [7], '- Wrong section.'),
      '8-empty.md': fragment('Fixed', [8], '   '),
      '9-dupe.md': fragment('Changed', [9], '- One.'),
      '9-DUPE.md': fragment('Changed', [9], '- Two.'),
    });
    const errors = check(bad.fragmentDir).errors;
    expect(errors.join('\n')).toMatch(/section "Nope"/);
    expect(errors.join('\n')).toMatch(/8-empty\.md: no bullet text/);
    expect(errors.join('\n')).toMatch(/duplicate file name/);
  });

  it('requires the <issue>-<slug>.md layout and a bullet body', () => {
    const parsed = parseFragment('---\nsection: Fixed\nissues: [12, 13]\n---\n- Fixed it.\n', '12-fixed.md');
    expect(parsed).toEqual({ name: '12-fixed.md', section: 'Fixed', issues: [12, 13], text: '- Fixed it.' });
    expect(parseFragment('---\nsection: Fixed\n---\n- Fixed it.\n', '12-fixed.md').issues).toEqual([12]);
    expect(checkFragments([{ ...parsed, name: 'Fixed.md' }]).join('\n')).toMatch(/name must be <issue>-<slug>\.md/);
    expect(checkFragments([{ ...parsed, text: 'Not a bullet' }]).join('\n')).toMatch(/must be a "- " bullet/);
  });

  it('builds sections in canonical order and sorts fragments by issue then file name', () => {
    const { fragmentDir, changelogPath } = workspace(base, {
      '10-late.md': fragment('Changed', [10], '- Late change.'),
      '2-beta.md': fragment('Added', [2], '- Beta change.'),
      '2-alpha.md': fragment('Added', [2], '- Alpha change.'),
      '3-fix.md': fragment('Fixed', [3], '- Fixed change.'),
    });

    const result = build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath });
    const section = result.section;
    expect(section).toContain('## [0.13.0] - 2026-11-08');
    expect(section.indexOf('### Added')).toBeLessThan(section.indexOf('### Changed'));
    expect(section.indexOf('### Changed')).toBeLessThan(section.indexOf('### Fixed'));
    expect(section.indexOf('- Alpha change.')).toBeLessThan(section.indexOf('- Beta change.'));
    expect(section.indexOf('- Unreleased change.')).toBeLessThan(section.indexOf('- Late change.'));

    const changelog = readFileSync(changelogPath, 'utf8');
    expect(changelog).not.toContain('## [Unreleased]');
    expect(changelog).toContain('## [0.12.0] - 2026-11-07');
    expect(readFragments(fragmentDir)).toEqual([]);
  });

  it('keeps the existing Upgrading from block and records fragment issues', () => {
    const changelog = `# Changelog

## [Unreleased]

### Added

- Pending addition.

### Upgrading from 0.12.0

- **Migrations:** none.
- **Upgrade:** the 0.12.0 wording.

## [0.12.0] - 2026-11-07

### Added

- Previous release.
`;
    const { fragmentDir, changelogPath } = workspace(changelog, {
      '4-new.md': fragment('Added', [4, 5], '- New addition.'),
    });

    const result = build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath });
    expect(result.section).toContain('### Upgrading from 0.12.0');
    expect(result.section).toContain('- **Upgrade:** the 0.12.0 wording.');
    expect(result.section).toContain('- Pending addition.');
    expect(result.section).toContain('- New addition.');
    expect(result.section).toContain('<!-- issues: 4, 5 -->');
  });

  it('merges repeated sections instead of overwriting the earlier one', () => {
    const changelog = `# Changelog

## [Unreleased]

### Changed

- First change.

### Changed

- Second change.

## [0.12.0] - 2026-11-07

### Added

- Previous release.
`;
    const { fragmentDir, changelogPath } = workspace(changelog);
    const result = build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath });
    expect(result.section).toContain('- First change.');
    expect(result.section).toContain('- Second change.');
  });

  it('refuses bare text before the first subsection and writes nothing', () => {
    const changelog = `# Changelog

## [Unreleased]

- Orphan bullet.

### Changed

- Real change.

## [0.12.0] - 2026-11-07

### Added

- Previous release.
`;
    const { fragmentDir, changelogPath } = workspace(changelog, {
      '1-new.md': fragment('Added', [1], '- New addition.'),
    });
    const before = readFileSync(changelogPath, 'utf8');
    expect(() => build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath })).toThrow(/Orphan bullet/);
    expect(readFileSync(changelogPath, 'utf8')).toBe(before);
    expect(readFragments(fragmentDir).map((item) => item.name)).toEqual(['1-new.md']);
  });

  it('merges a new fragment into a version section that already exists', () => {
    const changelog = `# Changelog

## [0.13.0] - 2026-11-08

### Added

- Already released.

## [0.12.0] - 2026-11-07

### Added

- Previous release.
`;
    const { fragmentDir, changelogPath } = workspace(changelog, {
      '1-new.md': fragment('Added', [1], '- New addition.'),
    });
    build({ version: '0.13.0', date: '2026-11-09', dir: fragmentDir, changelogPath });

    const next = readFileSync(changelogPath, 'utf8');
    expect(next).toContain('## [0.13.0] - 2026-11-08');
    expect(next).toContain('- Already released.');
    expect(next).toContain('- New addition.');
    expect(next).toContain('<!-- issues: 1 -->');
    expect(readFragments(fragmentDir)).toEqual([]);
  });

  it('folds again after a crash between the write and the fragment deletion, losing nothing', () => {
    const fragments = {
      '10-late.md': fragment('Changed', [10], '- Late change.'),
      '2-beta.md': fragment('Added', [2], '- Beta change.'),
    };
    const { fragmentDir, changelogPath } = workspace(base, fragments);

    const first = build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath });
    expect(readFragments(fragmentDir)).toEqual([]);

    // A kill after the atomic write but before the deletions leaves the fragments behind.
    for (const [name, text] of Object.entries(fragments)) writeFileSync(join(fragmentDir, name), text);

    const retried = build({ version: '0.13.0', date: '2026-11-09', dir: fragmentDir, changelogPath });

    expect(retried.consumed.sort()).toEqual(Object.keys(fragments).sort());
    // The existing section is kept as it was: a retry does not rewrite or lose a bullet.
    expect(readFileSync(changelogPath, 'utf8')).toBe(first.output);
    expect(readFragments(fragmentDir)).toEqual([]);
    expect(readFileSync(changelogPath, 'utf8').match(/- Beta change\./g)).toHaveLength(1);
    expect(readFileSync(changelogPath, 'utf8').match(/- Late change\./g)).toHaveLength(1);
  });

  it('merges a fragment added after such a crash without duplicating the ones already folded', () => {
    const folded = { '10-late.md': fragment('Changed', [10], '- Late change.') };
    const { fragmentDir, changelogPath } = workspace(base, folded);
    build({ version: '0.13.0', date: '2026-11-08', dir: fragmentDir, changelogPath });

    // The crash left the folded fragment behind, and a new fragment arrived before the retry.
    writeFileSync(join(fragmentDir, '10-late.md'), folded['10-late.md']);
    writeFileSync(join(fragmentDir, '12-new.md'), fragment('Added', [12], '- New after the crash.'));

    build({ version: '0.13.0', date: '2026-11-09', dir: fragmentDir, changelogPath });

    const changelog = readFileSync(changelogPath, 'utf8');
    expect(changelog.match(/- Late change\./g)).toHaveLength(1);
    expect(changelog.match(/- New after the crash\./g)).toHaveLength(1);
    expect(changelog).toContain('<!-- issues: 10, 12 -->');
    expect(readFragments(fragmentDir)).toEqual([]);
  });

  it('keeps a fragment whose bullet text matches a bullet in another section (#671)', () => {
    const changelog = `# Changelog

## [0.14.9] - 2026-11-11

### Added

- The ledger keeps the reason for every refusal.

<!-- issues: 700 -->
`;
    const { fragmentDir, changelogPath } = workspace(changelog, {
      '671-security.md': fragment('Security', [671], '- The ledger keeps the reason for every refusal.'),
    });

    build({ version: '0.14.9', date: '2026-11-12', dir: fragmentDir, changelogPath });

    const next = readFileSync(changelogPath, 'utf8');
    // The matching Added bullet is not a fold of the Security bullet: both stay, each in its section.
    expect(next).toMatch(/### Added\n\n- The ledger keeps the reason for every refusal\./);
    expect(next).toMatch(/### Security\n\n- The ledger keeps the reason for every refusal\./);
    expect(next.match(/The ledger keeps the reason for every refusal\./g)).toHaveLength(2);
    expect(next).toContain('<!-- issues: 671, 700 -->');
    expect(readFragments(fragmentDir)).toEqual([]);
  });

  it('records the issue marker of a fragment whose bullet is already folded (#671)', () => {
    const changelog = `# Changelog

## [0.14.9] - 2026-11-11

### Fixed

- Already folded.
`;
    const { fragmentDir, changelogPath } = workspace(changelog, {
      '671-issues.md': fragment('Fixed', [671], '- Already folded.'),
    });

    build({ version: '0.14.9', date: '2026-11-12', dir: fragmentDir, changelogPath });

    const next = readFileSync(changelogPath, 'utf8');
    // Dropping the fragment as already folded must not drop the issue it names.
    expect(next).toContain('<!-- issues: 671 -->');
    expect(next.match(/- Already folded\./g)).toHaveLength(1);
    expect(readFragments(fragmentDir)).toEqual([]);
  });

  it('refuses a version that is not full SemVer 2.0.0 before touching anything (#671)', () => {
    const { fragmentDir, changelogPath } = workspace(base, {
      '1-new.md': fragment('Added', [1], '- New addition.'),
    });
    const before = readFileSync(changelogPath, 'utf8');

    for (const version of ['0.14.3-..', '01.2.3', '1.2', 'v1.2.3', '1.2.3-']) {
      expect(() => build({ version, date: '2026-11-12', dir: fragmentDir, changelogPath }), version).toThrow(/not a version/);
    }

    expect(readFileSync(changelogPath, 'utf8')).toBe(before);
    expect(readFragments(fragmentDir).map((item) => item.name)).toEqual(['1-new.md']);
  });

  it('handles the empty case and leaves the files alone on a dry run', () => {
    const empty = workspace('# Changelog\n\nIntro.\n\n## [0.12.0] - 2026-11-07\n\n### Added\n\n- Previous release.\n');
    const result = build({ version: '0.13.0', date: '2026-11-08', dir: empty.fragmentDir, changelogPath: empty.changelogPath });
    expect(result.section).toBe('## [0.13.0] - 2026-11-08');
    expect(readFileSync(empty.changelogPath, 'utf8')).toContain('## [0.13.0] - 2026-11-08');

    const dry = workspace(base, { '6-dry.md': fragment('Added', [6], '- Dry change.') });
    const before = readFileSync(dry.changelogPath, 'utf8');
    const dryResult = build({
      version: '0.13.0',
      date: '2026-11-08',
      dir: dry.fragmentDir,
      changelogPath: dry.changelogPath,
      dryRun: true,
    });
    expect(dryResult.output).toBe(dryResult.section);
    expect(dryResult.section).toContain('- Dry change.');
    expect(readFileSync(dry.changelogPath, 'utf8')).toBe(before);
    expect(readFragments(dry.fragmentDir).map((item) => item.name)).toEqual(['6-dry.md']);
  });

  it('renders an explicit upgrade block when prepare supplies one', () => {
    const section = renderSection({
      version: '0.13.0',
      date: '2026-11-08',
      fragments: [parseFragment(fragment('Fixed', [8], '- A fix.'), '8-fix.md')],
      upgradeBlock: '### Upgrading from 0.12.0\n\n- **Migrations:** none.',
    });
    expect(section).toContain('- A fix.');
    expect(section).toContain('### Upgrading from 0.12.0');
  });
});
