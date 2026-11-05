import { z } from 'zod';

// An ISO 8601 date-time with a time zone, normalised to UTC. A date-time without a zone is
// ambiguous (whose midnight?), so it is rejected with an error that names the field and shows
// both accepted forms. This widens the old `z.iso.datetime()`, which only accepted `Z`.

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

// Formatters are immutable and expensive to construct; bound the cache for caller-supplied zones.
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in an IANA time zone. */
export interface ZonedTime {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

/** Wall-clock parts of an instant in a time zone (no dependency: Intl has the zone data). */
export function zonedParts(at: Date, timeZone: string): ZonedTime {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (zonedFormatters.size >= 128) zonedFormatters.delete(zonedFormatters.keys().next().value!);
    zonedFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/**
 * The UTC instant of a wall-clock time in a zone, by correcting a UTC guess with Intl's offset.
 * A wall-clock time skipped by a daylight-saving jump has no exact instant; callers that must
 * handle that case (rather than a schedule that merely needs a defensible instant) should resolve
 * it themselves.
 */
export function zonedInstant(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const wanted = Date.UTC(y, m - 1, d, h, min);
  let ts = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(ts), timeZone);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (actual === wanted) break;
    ts += wanted - actual;
  }
  return new Date(ts);
}

/**
 * A date-time input field: ISO 8601 with `Z` or a numeric offset (`+02:00`, `-0500`), optional
 * fractional seconds. The value is stored and returned as a UTC ISO string.
 */
export function isoDateTime(field: string) {
  const exampleZ = '2026-10-30T07:00:00Z';
  const exampleOffset = '2026-10-30T09:00:00+02:00';
  return z
    .string()
    .refine((value) => ISO_DATE_TIME.test(value), `${field} needs a time zone, e.g. ${exampleZ} or ${exampleOffset}.`)
    .refine((value) => !Number.isNaN(Date.parse(value)), `${field} must be a valid date and time, e.g. ${exampleZ}.`)
    .transform((value) => new Date(value).toISOString())
    .describe(`ISO 8601 with a time zone, e.g. ${exampleZ} or ${exampleOffset}; stored in UTC`);
}
