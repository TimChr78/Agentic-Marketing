import { describe, expect, it } from 'vitest';
import { canonicalJson, hashValue, ID_PATTERN, newId } from '../src';

describe('canonicalJson', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });
});

describe('newId', () => {
  it('creates prefixed, time-ordered ids', () => {
    const a = newId('jrn');
    const b = newId('jrn');
    expect(a).toMatch(ID_PATTERN);
    expect(a < b).toBe(true);
  });
});
