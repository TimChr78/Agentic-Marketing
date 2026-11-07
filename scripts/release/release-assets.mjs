#!/usr/bin/env node
// Require the exact release assets and their checksum lines (#521). A release that forgets the
// chart, the Compose bundle or a SHA256SUMS line must fail verification, not pass silently.
//
//   node scripts/release/release-assets.mjs <version> <download-dir>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The files every release publishes. */
export function expectedAssets(version) {
  return [`agentic-marketing-compose-${version}.tar.gz`, `agentic-marketing-${version}.tgz`, 'SHA256SUMS'];
}

/** Missing files and missing checksum lines. */
export function assetProblems({ version, files, sums }) {
  const expected = expectedAssets(version);
  const problems = [];
  for (const file of expected) if (!files.includes(file)) problems.push(`missing asset ${file}`);
  for (const file of expected.filter((name) => name !== 'SHA256SUMS')) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^[0-9a-f]{64}[ \\t]+\\*?${escaped}$`, 'm').test(sums)) {
      problems.push(`SHA256SUMS has no checksum line for ${file}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, dir] = process.argv.slice(2);
  if (!version || !dir) {
    console.error('usage: node scripts/release/release-assets.mjs <version> <download-dir>');
    process.exit(2);
  }
  const files = readdirSync(dir).filter((file) => statSync(join(dir, file)).isFile());
  const sums = existsSync(join(dir, 'SHA256SUMS')) ? readFileSync(join(dir, 'SHA256SUMS'), 'utf8') : '';
  const problems = assetProblems({ version, files, sums });
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`assets: ${expectedAssets(version).join(', ')}`);
}
