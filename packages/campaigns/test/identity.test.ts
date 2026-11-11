import { describe, expect, it } from 'vitest';
import { IDENTITY_MAP_LIMIT, type IdentityPair, identityMapOf, survivorOf } from '../src/identity';

const pair = (key: string, profileId: string, kind: IdentityPair['kind'] = 'anonymous_id'): IdentityPair => ({ key, profileId, kind });

describe('identity map', () => {
  it('follows a merge chain to its final survivor and stops on a cycle', () => {
    const mergedInto = new Map([
      ['prf_a', 'prf_b'],
      ['prf_b', 'prf_c'],
    ]);
    expect(survivorOf('prf_a', mergedInto)).toBe('prf_c');
    expect(survivorOf('prf_c', mergedInto)).toBe('prf_c');
    const cycle = new Map([
      ['prf_a', 'prf_b'],
      ['prf_b', 'prf_a'],
    ]);
    expect(['prf_a', 'prf_b']).toContain(survivorOf('prf_a', cycle));
  });

  it('deduplicates by kind and key and drops keys that already are their own profile', () => {
    const map = identityMapOf([
      pair('anon_1', 'prf_a'),
      pair('anon_1', 'prf_a'),
      pair('anon_1', 'prf_b'),
      pair('user_1', 'prf_b', 'user_id'),
      pair('prf_b', 'prf_b', 'profile'),
      pair('', 'prf_b'),
    ]);
    expect(map.pairs).toEqual([pair('anon_1', 'prf_a'), pair('user_1', 'prf_b', 'user_id')]);
    expect(map.overLimit).toBe(false);
    expect(map.limit).toBe(IDENTITY_MAP_LIMIT);
  });

  it('is over its bound rather than partial above the pair limit', () => {
    const pairs = Array.from({ length: IDENTITY_MAP_LIMIT + 1 }, (_, i) => pair(`anon_${i}`, `prf_${i}`));
    const map = identityMapOf(pairs);
    expect(map.pairs).toHaveLength(IDENTITY_MAP_LIMIT + 1);
    expect(map.overLimit).toBe(true);
  });

  it('is over its bound when the key text would not fit a parameter array', () => {
    const long = 'x'.repeat(48 * 1024);
    const map = identityMapOf([pair(long, 'prf_a'), pair(`${long}y`, 'prf_b'), pair(`${long}z`, 'prf_c')]);
    expect(map.pairs).toHaveLength(3);
    expect(map.overLimit).toBe(true);
  });
});
