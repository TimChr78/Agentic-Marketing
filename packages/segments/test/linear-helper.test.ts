import { describe, expect, it, vi } from 'vitest';
import { expectLinear } from '../../../test-support/linear';

// The helper re-measures before failing a ratio; a genuinely quadratic path must still fail it.
describe('expectLinear', () => {
  it('still fails quadratic work after re-measuring', () => {
    // Drive `performance.now` from a synthetic clock, as the audience helper self-test does (#816).
    // Real quadratic work at n = 2,000 finishes in fractions of a millisecond, so runner noise could
    // inflate the short measurement and hide the 16× ratio (#893). The clock makes the cost exact.
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let sink = 0;
      // Quadratic cost: 4× the input gives 16× the synthetic time.
      const quadratic = (input: string) => {
        sink += input.length;
        now += input.length ** 2 / 100_000;
      };
      expect(() => expectLinear((n) => 'x'.repeat(n), quadratic, 2_000)).toThrow(/expected linear scaling/);
      expect(sink).toBeGreaterThan(0);
      // Linear cost on the same clock passes, so the failure above is the ratio, not the ceiling.
      const linear = (input: string) => {
        now += input.length / 10;
      };
      expect(() => expectLinear((n) => 'x'.repeat(n), linear, 2_000)).not.toThrow();
    } finally {
      clock.mockRestore();
    }
  });

  it('passes linear work', () => {
    expectLinear(
      (n) => 'x'.repeat(n),
      (input) => input.split('').length,
      200_000,
    );
  });
});
