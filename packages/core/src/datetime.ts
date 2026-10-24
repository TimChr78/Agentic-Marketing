import { z } from 'zod';

// An ISO 8601 date-time with a time zone, normalised to UTC. A date-time without a zone is
// ambiguous (whose midnight?), so it is rejected with an error that names the field and shows
// both accepted forms. This widens the old `z.iso.datetime()`, which only accepted `Z`.

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

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
