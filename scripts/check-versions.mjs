#!/usr/bin/env node
// Every place that names the release version must agree with the root package.json (#175).
// Run by apps/server/test/version.test.ts and by the release workflow before it builds.
//
//   node scripts/check-versions.mjs            check against the root package.json
//   node scripts/check-versions.mjs 0.2.10     check against a given version (the tag)
//
// A version bump edits exactly the files listed in SURFACES; CHANGELOG.md needs a section too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(root + path, 'utf8');
const pkg = (path) => () => JSON.parse(read(path)).version;
const match = (path, re) => () => re.exec(read(path))?.[1];

export const SURFACES = [
  ['package.json', pkg('package.json')],
  ['apps/server/package.json', pkg('apps/server/package.json')],
  ['apps/web/package.json', pkg('apps/web/package.json')],
  ['packages/sdk-js/package.json', pkg('packages/sdk-js/package.json')],
  ['packages/edge-worker/package.json', pkg('packages/edge-worker/package.json')],
  ['Chart.yaml version', match('deploy/helm/agentic-marketing/Chart.yaml', /^version:\s*"?([^"\s]+)"?$/m)],
  ['Chart.yaml appVersion', match('deploy/helm/agentic-marketing/Chart.yaml', /^appVersion:\s*"?([^"\s]+)"?$/m)],
  ['.env.example AM_VERSION', match('.env.example', /^AM_VERSION=(\S+)$/m)],
  ['docker-compose.yml AM_VERSION default', match('docker-compose.yml', /agentic-marketing:\$\{AM_VERSION:-([^}]+)\}/)],
  ['README.md AM_VERSION default', match('README.md', /`AM_VERSION` \(default `([^`]+)`\)/)],
  [
    'CHANGELOG.md section',
    (v) =>
      read('CHANGELOG.md')
        .split('\n')
        .some((l) => l.startsWith(`## [${v}]`))
        ? v
        : 'no section',
  ],
];

/** The surfaces that disagree with `version`, as [name, found] pairs. */
export function mismatches(version) {
  const out = [];
  for (const [name, get] of SURFACES) {
    const found = get(version);
    if (found !== version) out.push([name, found ?? 'not found']);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? JSON.parse(read('package.json')).version).replace(/^v/, '');
  const bad = mismatches(version);
  for (const [name, found] of bad) console.error(`${name}: ${found}, expected ${version}`);
  if (bad.length) process.exit(1);
  console.log(`All ${SURFACES.length} version surfaces are ${version}.`);
}
