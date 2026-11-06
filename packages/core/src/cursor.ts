/**
 * Keyset cursors for timestamp-ordered lists: full-precision timestamp plus an id tie-break.
 *
 * `at` is the database's full-precision UTC timestamp text, not a JavaScript `Date`: Postgres
 * stores microseconds and `Date` only keeps milliseconds, so rounding would skip rows that share a
 * millisecond at a page boundary. Commands that page newest-first compare with `<`; commands that
 * page oldest-first compare with `>`.
 */
export interface TimestampKeysetCursor {
  /** Full-precision UTC timestamp from Postgres (legacy offset timestamps are also accepted). */
  at: string;
  id: string;
}

/** The opaque cursor for the last row of a page: `${at}~${id}`. */
export function encodeTimestampCursor(row: TimestampKeysetCursor): string {
  return `${row.at}~${row.id}`;
}

/** Parses a cursor, or returns null so the command can report a clear invalid_input error. */
export function decodeTimestampCursor(cursor: string): TimestampKeysetCursor | null {
  const at = cursor.lastIndexOf('~');
  if (at <= 0) return null;
  const timestamp = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!id || id.length > 128 || cursor.length > 256) return null;
  // Date.parse normalizes February 30 and accepts year zero; Postgres rejects both. Accept only
  // the ISO shapes emitted by the database and validate calendar/time fields before SQL casting.
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::(\d{2}))?(?::(\d{2}))?)$/.exec(
    timestamp,
  );
  if (!parts) return null;
  const [, y, m, d, h, min, sec, oh = '0', om = '0', os = '0'] = parts;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(sec) > 59 ||
    Number(oh) > 15 ||
    Number(om) > 59 ||
    Number(os) > 59
  )
    return null;
  return { at: timestamp, id };
}
