import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { dimension, parseAttributes, sanitiseFileName } from '../src/media';

// CodeQL alerts 15, 8 and 7 (js/polynomial-redos): uploaded SVG source reaches the attribute
// parser and dimension regex, and the uploaded file name reaches the trim. All three must run in
// linear time on hostile input. The checks compare n with 4n instead of a millisecond budget: a
// shared runner can be ten times slower without changing the ratio (#990 timing sweep).
const HOSTILE = 100_000;

describe('asset parsing is linear (js/polynomial-redos)', () => {
  it('parses a 100,000-character attribute name in linear time', () => {
    expect(parseAttributes('-'.repeat(HOSTILE))).toEqual({});
    expectLinear((n) => '-'.repeat(n), parseAttributes);
  });

  it('measures a 100,000-digit value followed by a non-unit in linear time', () => {
    expect(dimension(`${'0'.repeat(HOSTILE)}x`)).toBeNull();
    expectLinear((n) => `${'0'.repeat(n)}x`, dimension);
  });

  it('trims a 100,000-character dot run in linear time', () => {
    expect(sanitiseFileName(`a${'.'.repeat(HOSTILE)}b`)).toBe(`a${'.'.repeat(119)}`);
    expectLinear((n) => `a${'.'.repeat(n)}b`, sanitiseFileName);
  });

  it('keeps normal attribute parsing and dimensions unchanged', () => {
    expect(parseAttributes(' width="10" height=\'20\' viewBox="0 0 10 20" data-x = "y"')).toEqual({
      width: '10',
      height: '20',
      viewBox: '0 0 10 20',
      'data-x': 'y',
    });
    expect(dimension(' 10px ')).toBe(10);
    expect(dimension('.5in')).toBe(48);
    expect(dimension('12 pt')).toBe(16);
    expect(dimension('10 PX')).toBe(10);
    expect(dimension('0')).toBeNull();
    expect(dimension('12.')).toBeNull();
  });

  it('keeps normal file names unchanged', () => {
    expect(sanitiseFileName('Campaign hero (final).png')).toBe('Campaign-hero-final-.png');
    expect(sanitiseFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('...')).toBe('file');
    expect(sanitiseFileName(`${'-'.repeat(200)}name`)).toBe('name');
  });
});
