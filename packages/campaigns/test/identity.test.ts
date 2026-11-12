import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MAP_LIMIT,
  IDENTITY_MAP_MAX_BYTES,
  IDENTITY_PAIRS_PER_RECIPIENT,
  type IdentityPair,
  identityMapOf,
  MAX_CAMPAIGN_RECIPIENTS,
  mergeComponent,
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

  it('bounds the map by the largest campaign the platform supports (#590)', () => {
    // The bound is the campaign size, not a transport constant: 100,000 recipients (the
    // journeys.enrollSegment cap) times at most a merged profile and its two identifiers each.
    expect(IDENTITY_MAP_LIMIT).toBe(MAX_CAMPAIGN_RECIPIENTS * IDENTITY_PAIRS_PER_RECIPIENT);

    const pairs = Array.from({ length: 6 }, (_, i) => pair(`anon_${i}`, `prf_${i}`));
    const map = identityMapOf(pairs, 5);
    expect(map.pairs).toHaveLength(6);
    expect(map.overLimit).toBe(true);
    expect(map.limit).toBe(5);
  });

  it('is over its byte bound at the largest campaign and stays under it in the worst case', () => {
    // 300,000 pairs of 36-character keys and profile ids is 300,000 * (36 + 36 + 8) bytes.
    const worstCase = MAX_CAMPAIGN_RECIPIENTS * IDENTITY_PAIRS_PER_RECIPIENT * (36 + 36 + 8);
    expect(worstCase).toBeLessThanOrEqual(IDENTITY_MAP_MAX_BYTES);

    const long = 'x'.repeat(48 * 1024);
    const map = identityMapOf([pair(long, 'prf_a'), pair(`${long}y`, 'prf_b'), pair(`${long}z`, 'prf_c')], IDENTITY_MAP_LIMIT, 64 * 1024);
    expect(map.pairs).toHaveLength(3);
    expect(map.overLimit).toBe(true);
  });
});
