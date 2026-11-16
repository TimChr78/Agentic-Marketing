import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_IDEMPOTENCY_PREFIXES, reservedIdempotencyPrefix } from '../src/idempotency';

// #945: the platform builds deterministic idempotency keys for its own sends, and a caller who could
// pre-claim one would block that send with a fingerprint conflict. The reserved list is the one the
// send commands validate against, so it must cover every prefix an internal builder uses — a new
// builder with a new namespace would otherwise reopen the hole — and it must not carry a prefix
// nothing builds. This test reads the sources instead of trusting a hand-written list.

const root = fileURLToPath(new URL('../../../', import.meta.url));

function sourcesOf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourcesOf(path));
    } else if (entry.name.endsWith('.ts') && statSync(path).isFile()) out.push(path);
  }
  return out;
}

function trackedSources(): { path: string; text: string }[] {
  const files = [
    ...readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .flatMap((entry) => {
        const dir = join(root, 'packages', entry.name, 'src');
        try {
          return sourcesOf(dir);
        } catch {
          return [];
        }
      }),
    ...sourcesOf(join(root, 'apps', 'server', 'src')),
  ];
  return files.map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
}

describe('the reserved idempotency prefixes match the internal key builders (#945)', () => {
  it('reserves every prefix an internal idempotency key uses', () => {
    const built = new Map<string, string[]>();
    for (const { path, text } of trackedSources()) {
      // `idempotencyKey: \`prefix:...\`` — the shape every internal builder writes.
      for (const match of text.matchAll(/idempotencyKey:\s*`([a-z][a-z0-9-]*):/g)) {
        const prefix = `${match[1]}:`;
        built.set(prefix, [...(built.get(prefix) ?? []), path]);
      }
    }
    expect(built.size).toBeGreaterThan(10);
    for (const [prefix, paths] of built)
      expect(reservedIdempotencyPrefix(`${prefix}value`), `${prefix} built in ${paths.join(', ')}`).toBe(prefix);
  });

  it('reserves no prefix nothing builds', () => {
    const all = trackedSources()
      .map((s) => s.text)
      .join('\n');
    for (const prefix of RESERVED_IDEMPOTENCY_PREFIXES) expect(all, prefix).toContain(`${prefix}`);
  });

  it('accepts a key of the caller’s own', () => {
    expect(reservedIdempotencyPrefix('order-1234')).toBeNull();
    expect(reservedIdempotencyPrefix('Rechnung 2026-11')).toBeNull();
  });
});
