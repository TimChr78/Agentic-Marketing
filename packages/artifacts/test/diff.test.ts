import { describe, expect, it } from 'vitest';
import { diffJson } from '../src/diff';

describe('diffJson', () => {
  it('matches array items by id, so reordering is not a change', () => {
    const before = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    };
    const after = {
      nodes: [
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A2' },
        { id: 'c', label: 'C' },
      ],
    };
    expect(diffJson(before, after)).toEqual([
      { path: 'nodes[a].label', kind: 'changed', before: 'A', after: 'A2' },
      { path: 'nodes[c]', kind: 'added', after: { id: 'c', label: 'C' } },
    ]);
  });

  it('reports added and removed fields', () => {
    expect(diffJson({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { path: 'b', kind: 'removed', before: 2 },
      { path: 'c', kind: 'added', after: 3 },
    ]);
  });
});
