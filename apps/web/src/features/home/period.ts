import { getWorkspaceTimeZone, wallTimeToIso } from '../../ui/time';

// Home reads the last seven *complete local calendar days* (#447). The period is frozen when a
// load starts, so a refresh after midnight moves it and the blocks on screen never disagree about
// which days they describe. Calendar arithmetic is done on local date parts, not on milliseconds,
// so a DST change inside the range cannot shorten or lengthen it.

export interface HomePeriod {
  /** Local midnight seven days ago, inclusive. ISO with the zone's offset. */
  from: string;
  /** Today's local midnight, exclusive. ISO with the zone's offset. */
  to: string;
  /** The seven days immediately before `from`/`to`. */
  previousFrom: string;
  previousTo: string;
  /** `YYYY-MM-DD` keys for Analytics links, inclusive. */
  fromDay: string;
  toDay: string;
  /** "30 Oct–5 Nov 2026 · UTC" */
  label: string;
  zone: string;
}

export interface HomeClock {
  now: Date;
  period: HomePeriod;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function localParts(at: Date, zone: string): DateParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function addDays({ year, month, day }: DateParts, days: number): DateParts {
  const d = new Date(Date.UTC(year, month - 1, day + days, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const dayKey = ({ year, month, day }: DateParts) => `${year}-${pad(month)}-${pad(day)}`;

function localMidnight({ year, month, day }: DateParts, zone: string): string {
  const iso = wallTimeToIso(`${dayKey({ year, month, day })}T00:00`, zone);
  if (!iso) throw new Error(`Cannot resolve local midnight for ${year}-${month}-${day} in ${zone}.`);
  return iso;
}

function formatDay(parts: DateParts, withYear = false): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
}

function zoneLabel(zone: string, at: Date): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}

/** The seven complete local days before today, and the seven before those. */
export function homePeriod(now: Date, zone = getWorkspaceTimeZone()): HomePeriod {
  const today = localParts(now, zone);
  const start = addDays(today, -7);
  const endInclusive = addDays(today, -1);
  const previousStart = addDays(today, -14);
  const sameYear = start.year === endInclusive.year;
  return {
    from: localMidnight(start, zone),
    to: localMidnight(today, zone),
    previousFrom: localMidnight(previousStart, zone),
    previousTo: localMidnight(start, zone),
    fromDay: dayKey(start),
    toDay: dayKey(endInclusive),
    label: `${formatDay(start, !sameYear)}–${formatDay(endInclusive, true)} · ${zoneLabel(zone, now)}`,
    zone,
  };
}

export function homeClock(now = new Date(), zone = getWorkspaceTimeZone()): HomeClock {
  return { now, period: homePeriod(now, zone) };
}

/** The Analytics range for a Home period, in the date-only form its picker uses. */
export function analyticsHref(period: HomePeriod): string {
  return `/insights/analytics?from=${period.fromDay}&to=${period.toDay}`;
}
