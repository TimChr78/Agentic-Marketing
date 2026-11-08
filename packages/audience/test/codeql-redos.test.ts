import { describe, expect, it } from 'vitest';
import { plain, slugify } from '../src/archive';

// CodeQL alerts 16 and 9 (js/polynomial-redos): the slug trim and the tag-stripping regex both
// take polynomial time on a long hostile string. Issue subjects and preheaders come from
// templates and briefs, so both must be linear.
const HOSTILE = 100_000;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

describe('archive helpers are linear (js/polynomial-redos)', () => {
  it('slugifies a 100,000-character dash run well under 100 ms', () => {
    const { value, ms } = timed(() => slugify(`${'-'.repeat(HOSTILE)}Signal${'-'.repeat(HOSTILE)}`));

    expect(value).toBe('signal');
    expect(ms).toBeLessThan(100);
  });

  it('strips tags from 100,000 unmatched "<" characters well under 100 ms', () => {
    const source = '<'.repeat(HOSTILE);
    const { value, ms } = timed(() => plain(source));

    // The old regex cannot match without a ">", so the text is unchanged apart from whitespace.
    expect(value).toBe(source);
    expect(ms).toBeLessThan(100);
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
