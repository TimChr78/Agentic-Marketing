import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { durationSeconds } from '../src/evaluate';

// CodeQL alert 11 (js/polynomial-redos): `(\d+)([WDHM])` backtracks over every digit boundary
// when a long digit run has no unit. Segment conditions and journey waits call this, so it must
// stay linear without a length cap that would reject a valid duration.
const HOSTILE = 100_000;

describe('durationSeconds is linear (js/polynomial-redos)', () => {
  it('handles a long digit run with no unit in linear time', () => {
    const build = (n: number) => '0'.repeat(n);

    expect(durationSeconds(build(HOSTILE))).toBe(0);
    expectLinear(build, (value) => durationSeconds(value), HOSTILE / 2);
  });

  it('scans a long duration without a length cap, in linear time', () => {
    const build = (n: number) => `P${'1D'.repeat(n / 2)}`;

    expect(durationSeconds(build(HOSTILE))).toBe((HOSTILE / 2) * 86_400);
    expectLinear(build, (value) => durationSeconds(value), HOSTILE / 2);
  });

  it('accepts a duration just over the old 64-character cap', () => {
    expect(durationSeconds(`P${'0'.repeat(63)}1D`)).toBe(86_400);
  });

  it('keeps every valid duration unchanged', () => {
    expect(durationSeconds('P1W')).toBe(604_800);
    expect(durationSeconds('P2D')).toBe(172_800);
    expect(durationSeconds('P1DT2H')).toBe(93_600);
    expect(durationSeconds('PT30M')).toBe(1_800);
    expect(durationSeconds('PT6H')).toBe(21_600);
    expect(durationSeconds('nonsense')).toBe(0);
    expect(durationSeconds('12X34D')).toBe(34 * 86_400);
  });
});
