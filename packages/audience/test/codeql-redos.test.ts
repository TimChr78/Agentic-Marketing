import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { plain, slugify } from '../src/archive';

// CodeQL alerts 16 and 9 (js/polynomial-redos): the slug trim and the tag-stripping regex both
// take polynomial time on a long hostile string. Issue subjects and preheaders come from
// templates and briefs, so both must be linear.
const HOSTILE = 100_000;

describe('archive helpers are linear (js/polynomial-redos)', () => {
  it('slugifies a long dash run in linear time', () => {
    const build = (n: number) => `${'-'.repeat(n)}Signal${'-'.repeat(n)}`;

    expect(slugify(build(HOSTILE))).toBe('signal');
    expectLinear(build, (value) => slugify(value), HOSTILE / 2);
  });

  it('strips tags from long runs of unmatched "<" in linear time', () => {
    const build = (n: number) => '<'.repeat(n);

    expect(plain(build(HOSTILE))).toBe(build(HOSTILE));
    expectLinear(build, (value) => plain(value), HOSTILE / 2);
  });

  it('keeps normal slugs and plain text unchanged', () => {
    expect(slugify('Signal #42: attribution is…')).toBe('signal-42-attribution-is');
    expect(slugify('  ')).toBe('issue');
    expect(slugify('A'.repeat(100))).toHaveLength(80);
    expect(plain('<p>Hello <b>world</b></p>')).toBe('Hello world');
    expect(plain('a < b')).toBe('a < b');
    expect(plain('x<y<z>')).toBe('x');
  });
});
