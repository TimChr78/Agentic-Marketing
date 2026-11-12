#!/usr/bin/env node
// The image tags a release publishes (#773). The exact version tag is always pushed. The floating
// `major.minor` tag (`:0.14`) is published only when this version is the newest release in its
// line: the workflow serialises a line with a concurrency group, and this guard covers the other
// half — a queued older patch that starts after a newer one has finished must not move the
// floating tag backwards.
//
//   node scripts/release/image-tags.mjs <version> <tags-file>
//   node scripts/release/image-tags.mjs <version> --exact-only
//
// <tags-file> holds every existing release tag, one per line (`v0.14.5`), as the workflow lists them. The output
// is the `tags:` input of docker/metadata-action. --exact-only is the conservative path for when
// the tag list cannot be read: publishing a stale floating tag is worse than not moving it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSemver, releaseLine } from './semver.mjs';

/** [major, minor, patch, isRelease, prerelease] so a prerelease sorts before its release. */
function versionKey(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1, match[4] ?? ''];
}

function compareKeys(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
}

/**
 * Whether `version` is the highest release in its line among `tags`. A tag outside the line, a
 * non-version tag, or the same version (its own tag on a tag push) never blocks. An unreadable
 * tag list must be passed as --exact-only, not as an empty list.
 */
export function isNewestInLine(version, tags) {
  const line = releaseLine(version);
  const target = versionKey(version);
  if (!line || !target) throw new Error(`not a version: ${version}`);
  return tags.every((tag) => {
    const other = String(tag).trim().replace(/^v/, '');
    if (!isSemver(other) || releaseLine(other) !== line) return true;
    const key = versionKey(other);
    return key === null || compareKeys(key, target) <= 0;
  });
}

/**
 * Whether `version` is a stable release newer than every other stable release among `tags`, in any
 * line. Prereleases never become `latest` and never block it.
 */
export function isNewestStable(version, tags) {
  const target = versionKey(version);
  if (!target) throw new Error(`not a version: ${version}`);
  if (target[3] === 0) return false;
  return tags.every((tag) => {
    const key = versionKey(String(tag).trim().replace(/^v/, ''));
    return key === null || key[3] === 0 || compareKeys(key, target) <= 0;
  });
}

/**
 * The docker/metadata-action `tags:` input for this release. The workflow sets `flavor: latest=false`
 * so the action never adds `latest` on its own; it is listed here only for the newest stable release.
 * `tags` must be every release tag, not just this line's.
 */
export function imageTagSpec(version, tags, { exactOnly = false } = {}) {
  const lines = [`type=semver,pattern={{version}},value=${version}`];
  if (exactOnly) return lines.join('\n');
  if (isNewestInLine(version, tags)) lines.push(`type=semver,pattern={{major}}.{{minor}},value=${version}`);
  if (isNewestStable(version, tags)) lines.push('type=raw,value=latest');
  return lines.join('\n');
}

/** One tag per line, ignoring blanks and comments. */
export function parseTags(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const version = process.argv[2]?.replace(/^v/, '');
    if (!version) throw new Error('usage: node scripts/release/image-tags.mjs <version> <tags-file|--exact-only>');
    const source = process.argv[3];
    if (!source) throw new Error('usage: node scripts/release/image-tags.mjs <version> <tags-file|--exact-only>');
    const exactOnly = source === '--exact-only';
    const tags = exactOnly ? [] : parseTags(readFileSync(source, 'utf8'));
    console.log(imageTagSpec(version, tags, { exactOnly }));
  } catch (error) {
    console.error(`image-tags: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
