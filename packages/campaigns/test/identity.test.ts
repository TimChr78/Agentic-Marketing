import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MAP_LIMIT,
  IDENTITY_MAP_MAX_BYTES,
  IDENTITY_SCOPE_PROFILE_LIMIT,
  type IdentityPair,
  identityMapOf,
  MAX_CAMPAIGN_RECIPIENTS,
  mergeComponent,
  overLimitIdentityMap,
  survivorOf,
} from '../src/identity';

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

  it('expands a scoped id to both ends of its merge component (#590)', () => {
    // prf_a merged into prf_b, prf_b into prf_c. A recipient stored as any of them must resolve
    // to all three, because the send and the event can carry different historical ids.
    const mergedInto = new Map([
      ['prf_a', 'prf_b'],
      ['prf_b', 'prf_c'],
    ]);
    expect([...mergeComponent(['prf_a'], mergedInto)].sort()).toEqual(['prf_a', 'prf_b', 'prf_c']);
    expect([...mergeComponent(['prf_c'], mergedInto)].sort()).toEqual(['prf_a', 'prf_b', 'prf_c']);
    expect([...mergeComponent(['prf_other'], mergedInto)]).toEqual(['prf_other']);
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

  it('bounds the map in pairs, not recipients (#590)', () => {
    // A recipient can contribute more than three pairs (several anonymous ids, merge ancestors), so
    // the bound is the pair count itself and must not be derived from the audience size.
    expect(IDENTITY_MAP_LIMIT).toBeGreaterThan(MAX_CAMPAIGN_RECIPIENTS);
    // The scope read is capped at the same pair bound: one id contributes at least one pair.
    expect(IDENTITY_SCOPE_PROFILE_LIMIT).toBe(IDENTITY_MAP_LIMIT);

    const pairs = Array.from({ length: 6 }, (_, i) => pair(`anon_${i}`, `prf_${i}`));
    const map = identityMapOf(pairs, 5);
    expect(map.pairs).toHaveLength(6);
    expect(map.overLimit).toBe(true);
    expect(map.limit).toBe(5);

    expect(overLimitIdentityMap(7)).toEqual({ pairs: [], overLimit: true, limit: 7 });
  });

  it('keeps the pair bound inside its byte budget', () => {
    // The pair bound of 300,000 at 36-character keys and profile ids is 300,000 * (36 + 36 + 8).
    const worstCase = IDENTITY_MAP_LIMIT * (36 + 36 + 8);
    expect(worstCase).toBeLessThanOrEqual(IDENTITY_MAP_MAX_BYTES);

    const long = 'x'.repeat(48 * 1024);
    const map = identityMapOf([pair(long, 'prf_a'), pair(`${long}y`, 'prf_b'), pair(`${long}z`, 'prf_c')], IDENTITY_MAP_LIMIT, 64 * 1024);
    expect(map.pairs).toHaveLength(3);
    expect(map.overLimit).toBe(true);
  });
});
