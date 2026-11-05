import { describe, expect, it } from 'vitest';
import { attributeSplitOutcomes, type SplitEntry, type SplitOutcome } from '../src/split';

// #369: a conversion or unsubscribe belongs to exactly one split entry, even when a profile
// re-enters and lands in another arm. These cases pin the rule before the server suite runs it
// through ClickHouse.

const entry = (participantId: number, profileId: string, arm: number, at: number): SplitEntry => ({
  participantId,
  profileId,
  arm,
  at,
});

const outcome = (profileId: string, at: number, participantId?: number): SplitOutcome => ({
  profileId,
  at,
  ...(participantId != null ? { participantId } : {}),
});

describe('split outcome attribution', () => {
  it('credits a re-entrant outcome to the entry active at the time, not every arm', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_a', 0, 1_000), entry(2, 'prf_a', 1, 3_000)],
      {
        converted: [outcome('prf_a', 2_000, 1), outcome('prf_a', 4_000, 2)],
        unsubscribed: [outcome('prf_a', 2_500, 1)],
      },
      2,
    );
    expect(counts).toEqual([
      { entered: 1, converted: 1, unsubscribed: 1 },
      { entered: 1, converted: 1, unsubscribed: 0 },
    ]);
  });

  it('ignores outcomes before the first eligible entry', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_a', 0, 1_000)],
      { converted: [outcome('prf_a', 999)], unsubscribed: [outcome('prf_a', 0)] },
      2,
    );
    expect(counts).toEqual([
      { entered: 1, converted: 0, unsubscribed: 0 },
      { entered: 0, converted: 0, unsubscribed: 0 },
    ]);
  });

  it('breaks equal timestamp ties by participant id, independent of input order', () => {
    const entries = [entry(10, 'prf_tied', 0, 1_000), entry(11, 'prf_tied', 1, 1_000)];
    const outcomes = { converted: [outcome('prf_tied', 1_000)], unsubscribed: [] };
    const forward = attributeSplitOutcomes(entries, outcomes, 2);
    const reversed = attributeSplitOutcomes([...entries].reverse(), outcomes, 2);
    expect(forward).toEqual(reversed);
    expect(forward.map((c) => c.converted)).toEqual([0, 1]);
  });

  it('keeps a repeated take on the first recorded arm', () => {
    // `journeySplitArms` returns one entry per participant: the first take by (at, seq, detail).
    const counts = attributeSplitOutcomes(
      [entry(7, 'prf_loop', 0, 1_000)],
      { converted: [outcome('prf_loop', 5_000, 7)], unsubscribed: [] },
      2,
    );
    expect(counts).toEqual([
      { entered: 1, converted: 1, unsubscribed: 0 },
      { entered: 0, converted: 0, unsubscribed: 0 },
    ]);
  });

  it('attributes an unsubscribe without a participant to the latest preceding entry', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_b', 0, 1_000), entry(2, 'prf_b', 1, 2_000)],
      { converted: [], unsubscribed: [outcome('prf_b', 1_500)] },
      2,
    );
    expect(counts.map((c) => c.unsubscribed)).toEqual([1, 0]);
  });

  it('does not attribute a participant outcome to another profile entry', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_other', 0, 1_000), entry(2, 'prf_target', 1, 1_000)],
      { converted: [outcome('prf_target', 2_000, 1)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([0, 1]);
  });
});
