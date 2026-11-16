import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fingerprintFields, fingerprintParts } from '../src/fingerprint';

// #948: the published field list of the send fingerprints drifted from the shipped hashes in both
// directions (it claimed a journey hashed the recipient and template, it omitted the DOI's form and
// form version, and it gave broadcast and holdout fields neither hashes). The builders are now the
// only place the fields are written, this list is the documentation, and the two are compared here;
// a grep keeps every `sendRequestHash` call site building its parts through a builder, so a new
// call site cannot bypass the list either.

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** One fixture per builder: the value does not matter, only which fields the builder writes. */
const fixtures = {
  direct: { caller: 'caller-hash', recipient: 'prf_a', template: 'eml_a', data: { sku: 'TENT-2' } },
  doi: { submission: 'evt_a', form: 'frm_a', formVersion: 3, template: 'eml_a' },
  journey: { journey: 'jrn_a', enrollment: 42, step: 'email', sequence: 2 },
  broadcast: { recipient: 'prf_a', broadcast: 'bct_a' },
  broadcastControl: { recipient: 'prf_a', broadcast: 'bct_a', campaign: 'cmp_a' },
  test: { recipient: 'address-hash', template: 'eml_a' },
  alert: { recipient: 'user_a', key: 'alert:evt:key' },
} as const;

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

describe('the documented fingerprint fields are the shipped ones (#948)', () => {
  it('has a builder and a documented field list for the same sources', () => {
    expect(Object.keys(fingerprintParts).sort()).toEqual(Object.keys(fingerprintFields).sort());
  });

  for (const source of Object.keys(fingerprintParts) as (keyof typeof fingerprintParts)[]) {
    it(`${source} binds exactly its documented fields`, () => {
      const parts = fingerprintParts[source](fixtures[source] as never);
      expect(Object.keys(parts)).toEqual([...fingerprintFields[source]]);
    });
  }

  it('pins the system callers, so a fingerprint always says which send it belongs to', () => {
    const system = (source: keyof typeof fingerprintParts) =>
      (fingerprintParts[source](fixtures[source] as never) as { caller?: string }).caller;
    expect(system('doi')).toBe('system:doi');
    expect(system('journey')).toBe('system:journey');
    expect(system('broadcast')).toBe('system:broadcast');
    expect(system('broadcastControl')).toBe('system:broadcast_holdout');
    expect(system('test')).toBe('system:test');
    expect(system('alert')).toBe('system:alert');
  });

  it('builds every sendRequestHash call site through a builder', () => {
    const files = [
      ...readdirSync(join(root, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .flatMap((entry) => {
          try {
            return sourcesOf(join(root, 'packages', entry.name, 'src'));
          } catch {
            return [];
          }
        }),
      ...sourcesOf(join(root, 'apps', 'server', 'src')),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      if (path.endsWith(join('packages', 'email', 'src', 'fingerprint.ts'))) continue;
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/sendRequestHash\(/g)) {
        const at = (match.index ?? 0) + match[0].length;
        // Skip the definition itself; every call builds its parts through a builder.
        if (text.slice(Math.max(0, (match.index ?? 0) - 20), match.index).includes('export function ')) continue;
        // The channel argument comes first, then the parts: look a little past the opening call.
        if (!text.slice(at, at + 240).includes('fingerprintParts.'))
          offenders.push(`${relative(root, path)}: ${text.slice(match.index ?? 0, at + 40).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
