import { describe, expect, it } from 'vitest';
import { dimension, parseAttributes, sanitiseFileName } from '../src/media';

// CodeQL alerts 15, 8 and 7 (js/polynomial-redos): uploaded SVG source reaches the attribute
// parser and dimension regex, and the uploaded file name reaches the trim. All three must run in
// linear time on hostile input.
const HOSTILE = 100_000;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

describe('asset parsing is linear (js/polynomial-redos)', () => {
  it('parses a 100,000-character attribute name well under 100 ms', () => {
    const { value, ms } = timed(() => parseAttributes('-'.repeat(HOSTILE)));

    expect(value).toEqual({});
    expect(ms).toBeLessThan(100);
  });

  it('measures a 100,000-digit value followed by a non-unit well under 100 ms', () => {
    const { value, ms } = timed(() => dimension(`${'0'.repeat(HOSTILE)}x`));

    expect(value).toBeNull();
    expect(ms).toBeLessThan(100);
  });

  it('trims a 100,000-character dot run well under 100 ms', () => {
    const { value, ms } = timed(() => sanitiseFileName(`a${'.'.repeat(HOSTILE)}b`));

    expect(value).toBe(`a${'.'.repeat(119)}`);
    expect(ms).toBeLessThan(100);
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
