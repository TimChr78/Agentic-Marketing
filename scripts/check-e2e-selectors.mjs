#!/usr/bin/env node
// Selector hygiene for the Playwright suite (#248): a `getByLabel(...)` matches any element whose
// label or aria-label contains the text, so a second field with a similar label silently breaks the
// spec. Every call must either pass `{ exact: true }` or use `getByRole(role, { name, exact: true })`
// / a `data-testid`.
//
//   node scripts/check-e2e-selectors.mjs     # or: pnpm e2e:selectors (part of pnpm lint)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = join(root, 'e2e');

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The arguments of the call whose open parenthesis is at `open`, with balanced parentheses. */
function callArguments(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

const failures = [];
for (const file of files(e2e).filter((f) => /\.(?:ts|mjs|js)$/.test(f))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/getByLabel\s*\(/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (source.slice(lineStart, match.index).includes('//')) continue;
    const open = match.index + match[0].length - 1;
    const args = callArguments(source, open);
    if (args === null) continue;
    if (/\bexact\s*:\s*true\b/.test(args)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    failures.push({
      file: relative(root, file),
      line,
      text: source.slice(lineStart, source.indexOf('\n', match.index)).trim(),
    });
  }
}

if (failures.length) {
  console.error('getByLabel(...) must pass { exact: true } or use getByRole/data-testid:');
  for (const failure of failures) console.error(`  ${failure.file}:${failure.line}  ${failure.text}`);
  process.exit(1);
}
console.log(`e2e selectors: ${files(e2e).filter((f) => /\.(?:ts|mjs|js)$/.test(f)).length} files checked, every getByLabel is exact`);
