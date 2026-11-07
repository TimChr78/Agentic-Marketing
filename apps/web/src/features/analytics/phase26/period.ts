import { dayStartIso } from '../../../pages/insights/analyticsParams';
import { wallTimeToIso } from '../../../ui/time';
import { dayLabel, type LocalDayPeriod, localDayPeriod, periodDateLabel } from '../../broadcasts/period';

// Analytics periods reuse the Phase 25 local-calendar-day logic without editing its owner files.
// A query is inclusive at `to`, so `to` is the last millisecond before the next local midnight.

export type AnalyticsRange = LocalDayPeriod;

export { dayLabel, periodDateLabel };

/** The last `days` complete local days ending yesterday, in the workspace zone. */
export function completeDayRange(days: 7 | 30, now = new Date(), zone: string): AnalyticsRange {
  return localDayPeriod(days, now, zone);
}

const DAY_MS = 86_400_000;

function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDate}T00:00:00.000Z`).getTime();
  return Math.floor((to - from) / DAY_MS) + 1;
}

/** A validated date-only range (YYYY-MM-DD), inclusive, resolved to local midnights in `zone`. */
export function rangeFromDates(fromDate: string, toDate: string, zone: string): AnalyticsRange {
  const nextDate = shiftDay(toDate, 1);
  const from = dayStartIso(fromDate, zone);
  const nextMidnight = dayStartIso(nextDate, zone);
  return {
    from,
    to: new Date(new Date(nextMidnight).getTime() - 1).toISOString(),
    nextMidnight,
    fromDate,
    toDate,
    nextDate,
    zone,
    days: daysBetween(fromDate, toDate),
  };
}

/** The immediately preceding equal number of local calendar days. */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const toDate = shiftDay(range.fromDate, -1);
  const fromDate = shiftDay(toDate, -(range.days - 1));
  return rangeFromDates(fromDate, toDate, range.zone);
}

/** The local calendar day of an instant in `zone`, as YYYY-MM-DD. */
export function localDayOfInstant(iso: string, zone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}

/** Every local calendar day in the period, inclusive, as YYYY-MM-DD. */
export function periodDays(range: Pick<AnalyticsRange, 'fromDate' | 'toDate'>): string[] {
  const days: string[] = [];
  for (let day = range.fromDate; day <= range.toDate; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/** Midnight in the workspace zone for a date-only day, as ISO. */
export function midnightIso(day: string, zone: string): string {
  const iso = wallTimeToIso(`${day}T00:00`, zone);
  return iso ? new Date(iso).toISOString() : `${day}T00:00:00.000Z`;
}

export function dateTimeLabelIn(iso: string | null | undefined, zone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return null;
  }
}
