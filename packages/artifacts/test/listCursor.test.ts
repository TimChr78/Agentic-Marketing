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
});
