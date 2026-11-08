import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TYPE_BY_PREFIX } from '../../artifacts/pickerIndex';

// The web bundle does not import the artifact registry, so the picker index keeps its own copy of
// the id prefixes. This guard fails when a type is added or renamed on the server without it.
describe('picker index id prefixes', () => {
  it('match the server artifact registry', () => {
    const source = readFileSync(resolve(__dirname, '../../../../../../packages/artifacts/src/types.ts'), 'utf8');
    const registry = source.slice(source.indexOf('export const artifactTypes = {'));
    const server: Record<string, string> = {};
    for (const m of registry.matchAll(/^\s+([a-z_]+): \{\s*(?:\n\s*)?prefix: '([a-z]{3})'/gm)) server[m[2]] = m[1];
    expect(Object.keys(server).length).toBeGreaterThanOrEqual(23);
    expect(TYPE_BY_PREFIX).toEqual(server);
  });
});
