// Timestamp validation for the keyset cursors of `profiles.list` and `profiles.events` (#397).
//
// Postgres stores microseconds and ClickHouse stores milliseconds; a JavaScript `Date` only keeps
// milliseconds. The cursor therefore keeps the timestamp text the store produced and the handler
// casts it back in SQL, so rows that share a millisecond are neither skipped nor repeated.
// Validate calendar/time fields here, before the text reaches a database cast, so a malformed
// cursor fails as invalid_input instead of surfacing a SQL error.

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-](\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)$/;

/** Whether `value` is an ISO-shaped timestamp with a time zone and valid calendar fields. */
export function isProfileCursorTimestamp(value: string): boolean {
  const parts = TIMESTAMP.exec(value);
  if (!parts) return false;
  const [, y, m, d, h, min, sec, , oh = '0', om = '0', os = '0'] = parts;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return !(
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
  );
}
