import { describe, expect, it } from 'vitest';
import { durationSeconds } from '../src/evaluate';

// CodeQL alert 11 (js/polynomial-redos): `(\d+)([WDHM])` backtracks over every digit boundary
// when a long digit run has no unit. Segment conditions and journey waits call this, so it must
// stay linear without a length cap that would reject a valid duration.
const HOSTILE = 100_000;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

describe('durationSeconds is linear (js/polynomial-redos)', () => {
  it('handles 100,000 digits with no unit well under 100 ms', () => {
    const { value, ms } = timed(() => durationSeconds('0'.repeat(HOSTILE)));

    expect(value).toBe(0);
    expect(ms).toBeLessThan(100);
  });

  it('scans a long duration without a length cap, in linear time', () => {
    const { value, ms } = timed(() => durationSeconds(`P${'1D'.repeat(HOSTILE / 2)}`));

    expect(value).toBe((HOSTILE / 2) * 86_400);
    expect(ms).toBeLessThan(100);
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
