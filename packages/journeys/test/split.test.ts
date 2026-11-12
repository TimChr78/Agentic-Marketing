import { anyArmBelowK } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { attributeSplitOutcomes, type SplitEntry, type SplitOutcome, splitArmPeople } from '../src/split';

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

  it('counts each entry at most once for repeated conversion and unsubscribe events', () => {
    const result = attributeSplitOutcomes(
      [entry(1, 'prf_repeat', 0, 1_000), entry(2, 'prf_repeat', 1, 3_000)],
      {
        converted: [
          outcome('prf_repeat', 1_100, 1),
          outcome('prf_repeat', 1_200, 1),
          outcome('prf_repeat', 3_100, 2),
          outcome('prf_repeat', 3_200, 2),
        ],
        unsubscribed: [
          outcome('prf_repeat', 1_100),
          outcome('prf_repeat', 1_200),
          outcome('prf_repeat', 3_100),
          outcome('prf_repeat', 3_200),
        ],
      },
      2,
    );
    expect(result).toEqual([
      { entered: 1, converted: 1, unsubscribed: 1 },
      { entered: 1, converted: 1, unsubscribed: 1 },
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

  it('does not credit a conversion from an entry that bypassed the split (#419)', () => {
    // Participant 2 re-entered the journey and took a branch that skipped the split. Its
    // conversion still arrives because splitResult reads conversions for the whole journey.
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_bypass', 0, 1_000)],
      { converted: [outcome('prf_bypass', 3_000, 2)], unsubscribed: [] },
      2,
    );
    expect(counts).toEqual([
      { entered: 1, converted: 0, unsubscribed: 0 },
      { entered: 0, converted: 0, unsubscribed: 0 },
    ]);
  });

  it('does not credit a conversion before that participant reached the split', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_before', 0, 1_000), entry(2, 'prf_before', 1, 3_000)],
      { converted: [outcome('prf_before', 2_000, 2)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([0, 0]);
  });

  it('does not credit a participant with no split take', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_missing', 0, 1_000)],
      { converted: [outcome('prf_missing', 3_000, 9)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([0, 0]);
  });

  it('does not treat participant 0 as absent, because no storage sentinel exists', () => {
    // journey_participants.id is a positive bigserial and every journey-event writer passes it.
    // A 0 from storage is invalid data, never a reason to borrow the profile's latest take.
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_zero', 0, 1_000)],
      { converted: [outcome('prf_zero', 3_000, 0)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([0, 0]);
  });

  it('credits a valid direct participant take', () => {
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_direct', 0, 1_000), entry(2, 'prf_direct', 1, 3_000)],
      { converted: [outcome('prf_direct', 2_000, 1)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([1, 0]);
  });

  it('keeps a merged participant on its own take instead of another profile entry', () => {
    // A merge changes the profile id recorded on later events but not the journey participant.
    // Participant 1's own take remains the only eligible entry, even when the conversion carries
    // the survivor profile id (so per-profile fallback would have credited participant 2).
    const counts = attributeSplitOutcomes(
      [entry(1, 'prf_merged', 0, 1_000), entry(2, 'prf_survivor', 1, 1_000)],
      { converted: [outcome('prf_survivor', 2_000, 1)], unsubscribed: [] },
      2,
    );
    expect(counts.map((c) => c.converted)).toEqual([1, 0]);
  });
});

describe('splitArmPeople (0.14.11 review)', () => {
  it('counts one person who re-enters an arm five times as one person, so the arm stays below k', () => {
    const entries = [
      ...Array.from({ length: 5 }, () => ({ profileId: 'prf_one', arm: 0 })),
      ...['a', 'b', 'c', 'd', 'e'].map((p) => ({ profileId: `prf_${p}`, arm: 1 })),
    ];
    expect(splitArmPeople(entries, 2)).toEqual([1, 5]);
    expect(anyArmBelowK(splitArmPeople(entries, 2).map((n) => ({ entered: n })))).toBe(true);
  });

  it('ignores entries outside the arm range', () => {
    expect(splitArmPeople([{ profileId: 'prf_x', arm: 3 }], 2)).toEqual([0, 0]);
  });
});
