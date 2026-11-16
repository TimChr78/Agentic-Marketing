import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { slug } from '../src/brief';

// CodeQL alert 17 (js/polynomial-redos): the old `^-+|-+$` trim is quadratic on a long run that
// is not anchored at either end. A campaign name is library input, so it must stay linear. The
// check compares n with 4n rather than a millisecond budget, so a slow runner cannot fail it
// (#990 timing sweep).
const HOSTILE = 100_000;

describe('campaign slug is linear (js/polynomial-redos)', () => {
  it('trims a 100,000-character dash run in linear time', () => {
    expect(slug(`${'-'.repeat(HOSTILE)}Signal${'-'.repeat(HOSTILE)}`)).toBe('signal');
    expectLinear((n) => `${'-'.repeat(n)}Signal${'-'.repeat(n)}`, slug);
  });

  it('keeps normal slugs, the fallback and the 60-character limit unchanged', () => {
    expect(slug('Signal #42: attribution is…')).toBe('signal-42-attribution-is');
    expect(slug('  ')).toBe('campaign');
    expect(slug('A'.repeat(80))).toHaveLength(60);
    expect(slug(`${'-'.repeat(70)}campaign`)).toBe('campaign');
  });
});
