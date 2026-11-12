#!/usr/bin/env node
// The release version, checked against the full SemVer 2.0.0 grammar (#671).
//
//   node scripts/release/semver.mjs <version>
//
// Prints the normalised version (one leading `v` removed) on stdout and exits 0, or prints the
// problem on stderr and exits 1. `.github/workflows/release.yml` calls it in the prepare job, so a
// malformed version such as `0.14.3-..` fails the release before anything is built. prepare.mjs and
// changelog.mjs use the same check, so a hand-run release cannot drift from CI.
//
// The pattern is the official one from semver.org, anchored: numeric identifiers have no leading
// zero, a pre-release identifier is never empty, and build metadata has no leading zero rule.
import { fileURLToPath } from 'node:url';

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Whether `value` is a version in the SemVer 2.0.0 grammar, without a leading `v`. */
export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

/**
 * The version without one leading `v` and surrounding whitespace, or null when it is not SemVer
 * 2.0.0. Both release triggers pass their raw ref or input through here.
 */
export function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const version = value.trim().replace(/^v/, '');
  return isSemver(version) ? version : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = process.argv[2] ?? '';
  const version = normalizeVersion(raw);
  if (!version) {
    console.error(`::error::${raw || '(empty)'} is not a SemVer version (x.y.z, optionally -prerelease and +build)`);
    process.exit(1);
  }
  console.log(version);
}
