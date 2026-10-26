import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersions, LABELS, mergeUpgradeNotes, parseChangelog } from '../src/ops/upgrade-notes';

// `am upgrade-notes` reads the real CHANGELOG, so these tests also keep its upgrade blocks in the
// shape the command (and the release workflow) relies on (#135).
const changelog = await readFile(fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)), 'utf8');
const releases = parseChangelog(changelog);

describe('am upgrade-notes', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.4', '0.2.4')).toBe(0);
    expect(releases.map((r) => r.version).slice(0, 3)).toEqual(['0.1.0', '0.1.1', '0.1.2']);
  });

  it('finds the fixed upgrade block in every release since 0.2.4', () => {
    const shaped = releases.filter((r) => compareVersions(r.version, '0.2.4') >= 0);
    expect(shaped.length).toBeGreaterThan(0);
    for (const r of shaped) for (const label of LABELS) expect(r.fields[label], `${r.version} ${label}`).toBeTruthy();
  });

  it('merges every release between two versions, older free-form blocks in full', () => {
    const notes = mergeUpgradeNotes(releases, '0.2.2', '0.2.4');
    expect(notes).toContain('Upgrading from 0.2.2 to 0.2.4 (2 releases: 0.2.3, 0.2.4).');
    expect(notes).toContain('0027_journey_consent_exits.sql');
    expect(notes).toMatch(/Migrations:\n- 0\.2\.4: /);
    expect(notes).toMatch(/Upgrade \(0\.2\.4\):/);
    expect(notes).not.toContain('0.2.2 (upgrading');
  });

  it('counts the releases in the header', () => {
    expect(mergeUpgradeNotes(releases, '0.2.4', '0.2.5')).toMatch(/^Upgrading from 0\.2\.4 to 0\.2\.5 \(1 release: 0\.2\.5\)\.$/m);
    expect(mergeUpgradeNotes(releases, '0.2.2', '0.2.5')).toMatch(
      /^Upgrading from 0\.2\.2 to 0\.2\.5 \(3 releases: 0\.2\.3, 0\.2\.4, 0\.2\.5\)\.$/m,
    );
  });

  it('says when there is nothing to do', () => {
    expect(mergeUpgradeNotes(releases, '0.2.4', '0.2.4')).toMatch(/Nothing to do/);
  });
});
