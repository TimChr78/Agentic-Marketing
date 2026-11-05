import { describe, expect, it } from 'vitest';
import { isProfileCursorTimestamp } from '../src/cursor';

// #397: the cursor keeps the store's timestamp text and casts it back in SQL. It must reject a
// malformed or impossible date before that cast, while accepting the full-precision forms both
// stores emit.

describe('profile cursor timestamps', () => {
  it('accepts full-precision Postgres and ClickHouse shapes', () => {
    for (const value of [
      '2026-11-05T12:34:56.123456Z',
      '2026-11-05T12:34:56.123Z',
      '2026-11-05 12:34:56.123456+00',
      '2026-11-05T13:34:56+01:00',
    ])
      expect(isProfileCursorTimestamp(value)).toBe(true);
  });

  it('rejects impossible calendar and clock fields', () => {
    for (const value of [
      '2026-02-30T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-11-05T24:00:00Z',
      '2026-11-05T12:60:00Z',
      '0000-01-01T00:00:00Z',
      '2026-11-05T12:00:00',
      'not-a-time',
      '2026-11-05T12:00:00+16:00',
    ])
      expect(isProfileCursorTimestamp(value)).toBe(false);
  });
});
