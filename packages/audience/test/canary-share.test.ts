import { describe, expect, it } from 'vitest';
import { broadcastMemberOf, canaryMessageOf } from '../src/broadcasts';

// #1053/#1099: a canary message is identified by the segment member id the send selected, which the
// message's idempotency key records. A failed conflict row appends `:conflict`; it is recorded with
// the canonical person, and the parser must not treat the suffix as part of the id.

const broadcastId = 'bct_0123456789abcdef0123456789abcdef';
const person = 'prf_0123456789abcdef0123456789abcdef';
const other = 'prf_ffffffffffffffffffffffffffffffff';

const row = (overrides: Partial<{ idempotencyKey: string; profileId: string | null; status: string; reason: string | null }> = {}) => ({
  idempotencyKey: `bct:${broadcastId}:${person}`,
  profileId: other,
  status: 'failed',
  reason: null,
  ...overrides,
});

describe('the canary share’s member id (#1053)', () => {
  it('reads the member from a broadcast key, including a failed conflict row', () => {
    expect(broadcastMemberOf(`bct:${broadcastId}:${person}`, broadcastId)).toBe(person);
    expect(broadcastMemberOf(`bct:${broadcastId}:${person}:conflict`, broadcastId)).toBe(person);
    // Anything that is not a profile id, or not this broadcast's namespace, cannot invent a member.
    expect(broadcastMemberOf(`bct:${broadcastId}:not-a-profile`, broadcastId)).toBeNull();
    expect(broadcastMemberOf(`bct:${broadcastId}:${person}:other`, broadcastId)).toBeNull();
    expect(broadcastMemberOf(`bct:another-broadcast:${person}`, broadcastId)).toBeNull();
  });

  it('counts a conflict row whose selected member is in the canary share', () => {
    const conflict = row({ idempotencyKey: `bct:${broadcastId}:${person}:conflict`, reason: 'idempotency_conflict' });
    expect(canaryMessageOf(conflict, broadcastId, 100)).toBe(true);
    expect(canaryMessageOf(conflict, broadcastId, 0)).toBe(false);
    // A malformed key falls back to the stored profile id instead of hashing the raw suffix.
    expect(canaryMessageOf(row({ idempotencyKey: `bct:${broadcastId}:bad:conflict`, profileId: person }), broadcastId, 100)).toBe(true);
    // A deliberate holdout or window skip is not canary evidence.
    expect(canaryMessageOf(row({ status: 'suppressed', reason: 'holdout_control: campaign cmp_x' }), broadcastId, 100)).toBe(false);
  });
});
