import { expect } from 'vitest';

/** Timings under this are too short for a meaningful 4n/n ratio. */
const NOISE_FLOOR_MS = 20;

/** One warm-up run, then the best of three, so a slow CI runner cannot inflate the ratio. */
function bestOfThree(run: (input: string) => unknown, input: string): number {
  run(input);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run(input);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Assert that `run` scales linearly with the size of the input `build` produces. Compare the
 * same work at `n` and `4n`: linear code gives a ratio near 4, quadratic code near 16. A
 * generous absolute ceiling at `4n` stays as a backstop for something catastrophic.
 *
 * Absolute millisecond limits are flaky on shared CI runners: the same linear code can take
 * 7 ms locally and 128 ms there. The ratio is machine-independent.
 */
export function expectLinear(build: (n: number) => string, run: (input: string) => unknown, base = 25_000): void {
  const small = build(base);
  const large = build(base * 4);
  // A super-linear path gives a ratio near 16 on every attempt; a busy shared runner inflates one
  // measurement now and then (8.6 at 26 ms broke a release run). Re-measure up to two more times
  // before failing, and judge the best attempt, so noise cannot fail the check but a real slow
  // path still does.
  let best: { tSmall: number; tLarge: number; ratio: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tSmall = bestOfThree(run, small);
    const tLarge = bestOfThree(run, large);
    const ratio = tLarge / Math.max(tSmall, 0.5);
    if (!best || ratio < best.ratio) best = { tSmall, tLarge, ratio };
    if (tLarge < NOISE_FLOOR_MS || ratio < 8) break;
  }
  const { tSmall, tLarge, ratio } = best!;
  const detail = `n=${base}: ${tSmall.toFixed(2)} ms, 4n=${base * 4}: ${tLarge.toFixed(2)} ms (ratio ${ratio.toFixed(1)})`;

  // Below a few milliseconds the ratio measures timer noise and warm-up, not growth: a run that
  // takes 0.4 ms at n and 4.5 ms at 4n failed here on a CI runner. Work that finishes this fast at
  // 4n is not the slow path the check exists to catch, so only the ceiling applies.
  if (tLarge >= NOISE_FLOOR_MS) expect(ratio, `expected linear scaling, got ${detail}`).toBeLessThan(8);
  expect(tLarge, `expected 4n under 2,000 ms, got ${detail}`).toBeLessThan(2_000);
}
