import { describe, expect, it } from 'vitest';
import { decodeArtifactListCursor, encodeArtifactListCursor } from '../src/list';

describe('artifacts.list cursor (#382)', () => {
  it('round-trips the database timestamp and id without losing microseconds', () => {
    const updatedAt = '2026-11-04 12:34:56.789123+00';
    const cursor = encodeArtifactListCursor({ updatedAt, id: 'seg_0123456789abcdef0123456789abcdef' });
    expect(cursor).toBe(`${updatedAt}~seg_0123456789abcdef0123456789abcdef`);
    expect(decodeArtifactListCursor(cursor)).toEqual({ updatedAt, id: 'seg_0123456789abcdef0123456789abcdef' });
  });

  it('rejects malformed cursors instead of silently restarting the page', () => {
    expect(decodeArtifactListCursor('')).toBeNull();
    expect(decodeArtifactListCursor('not-a-date~seg_1')).toBeNull();
    expect(decodeArtifactListCursor('2026-11-04 12:34:56.789123+00~')).toBeNull();
    expect(decodeArtifactListCursor('2026-11-04 12:34:56.789123+00')).toBeNull();
  });
  it('rejects impossible calendar and time fields that Date.parse can normalize', () => {
    for (const stamp of [
      '2026-02-30 12:00:00+00',
      '2026-02-29T12:00:00Z',
      '0000-01-01T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T12:60:00Z',
      '2026-01-01T12:00:60Z',
      '2026-01-01T12:00:00+16',
      '0',
    ]) {
      expect(decodeArtifactListCursor(`${stamp}~not_1`)).toBeNull();
    }
    expect(decodeArtifactListCursor('2028-02-29T12:34:56.123456Z~not_1')).not.toBeNull();
    expect(decodeArtifactListCursor('2026-11-04 12:34:56.123456+05:30~not_1')).not.toBeNull();
  });
});
