#!/usr/bin/env node
// Gate the release notes before they can be published (#521). A release section must have a
// complete `### Upgrading from …` block: every field, a non-empty value and no TODO.
//
//   node scripts/release/check-notes.mjs [version]
//
// Without a version it validates the top released section, which is what a pull request that
// changes CHANGELOG.md must keep valid.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPreviousVersion, releaseSection, upgradeBlockOf, validateUpgradeBlock } from './prepare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The newest released section, skipping [Unreleased]. */
export function topReleaseVersion(changelog) {
  return findPreviousVersion(changelog);
}

/** Problems with one release section's upgrade block. */
export function releaseNotesErrors({ changelog, version }) {
  const target = version ?? topReleaseVersion(changelog);
  if (!target) return ['CHANGELOG.md has no released section'];
  const section = releaseSection(changelog, target);
  if (section === null) return [`CHANGELOG.md has no ## [${target}] section`];
  return validateUpgradeBlock(upgradeBlockOf(section)).map((error) => `${target} section ${error}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const version = process.argv[2]?.replace(/^v/, '');
    const target = version ?? topReleaseVersion(changelog);
    const errors = releaseNotesErrors({ changelog, version: target });
    if (errors.length) {
      for (const error of errors) console.error(`release notes: ${error}`);
      process.exit(1);
    }
    console.log(`release notes: ${target} is complete`);
  } catch (error) {
    console.error(`release notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
