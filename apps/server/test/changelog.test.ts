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
