import { describe, expect, it } from 'vitest';
import { slug } from '../src/brief';

// CodeQL alert 17 (js/polynomial-redos): the old `^-+|-+$` trim is quadratic on a long run that
// is not anchored at either end. A campaign name is library input, so it must stay linear.
const HOSTILE = 100_000;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

describe('campaign slug is linear (js/polynomial-redos)', () => {
  it('trims a 100,000-character dash run well under 100 ms', () => {
    const { value, ms } = timed(() => slug(`${'-'.repeat(HOSTILE)}Signal${'-'.repeat(HOSTILE)}`));

    expect(value).toBe('signal');
    expect(ms).toBeLessThan(100);
  });

  it('keeps normal slugs, the fallback and the 60-character limit unchanged', () => {
    expect(slug('Signal #42: attribution is…')).toBe('signal-42-attribution-is');
    expect(slug('  ')).toBe('campaign');
    expect(slug('A'.repeat(80))).toHaveLength(60);
    expect(slug(`${'-'.repeat(70)}campaign`)).toBe('campaign');
  });
});
