import { getWorkspaceTimeZone, wallTimeToIso } from '../../ui/time';

// Report periods (#500): whole local calendar days in the workspace zone. Building each boundary
// with `wallTimeToIso` keeps DST transitions honest. The analytics query compares with `<= to`, so
// `to` is the last millisecond of the last local day while `nextMidnight` stays separate for human
// labels and Analytics links.

function localDateParts(date: Date, zone: string): { year: number; month: number; day: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: parts.day };
}

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

const localMidnightIso = (day: string, zone: string): string => {
  const iso = wallTimeToIso(`${day}T00:00`, zone);
  return iso ? new Date(iso).toISOString() : `${day}T00:00:00.000Z`;
};

export interface LocalDayPeriod {
  /** The first local midnight, inclusive. */
  from: string;
  /** The last millisecond of the last local day, inclusive (analytics compares with `<= to`). */
  to: string;
  /** The exclusive next local midnight after the last complete day. */
  nextMidnight: string;
  /** First day, inclusive, as YYYY-MM-DD. */
  fromDate: string;
  /** Last day, inclusive, as YYYY-MM-DD. */
  toDate: string;
  /** The exclusive day after `toDate`, as YYYY-MM-DD. */
  nextDate: string;
  zone: string;
  days: number;
}

/**
 * The last `days` complete local calendar days ending yesterday. Calendar-day arithmetic is done on
 * date parts, then each boundary is resolved in the workspace zone, so a DST change inside the
 * range neither shortens nor lengthens it.
 */
export function localDayPeriod(days: number, now = new Date(), zone = getWorkspaceTimeZone()): LocalDayPeriod {
  const today = localDateParts(now, zone);
  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, Number(today.day)));
  const firstUtc = new Date(todayUtc.getTime() - days * 86_400_000);
  const lastUtc = new Date(todayUtc.getTime() - 86_400_000);
  const fromDate = dateOnly(firstUtc);
  const toDate = dateOnly(lastUtc);
  const nextDate = dateOnly(todayUtc);
  const from = localMidnightIso(fromDate, zone);
  const nextMidnight = localMidnightIso(nextDate, zone);
  return {
    from,
    to: new Date(new Date(nextMidnight).getTime() - 1).toISOString(),
    nextMidnight,
    fromDate,
    toDate,
    nextDate,
    zone,
    days,
  };
}

export function lastSevenLocalDays(now = new Date(), zone = getWorkspaceTimeZone()): LocalDayPeriod {
  return localDayPeriod(7, now, zone);
}

export function lastThirtyLocalDays(now = new Date(), zone = getWorkspaceTimeZone()): LocalDayPeriod {
  return localDayPeriod(30, now, zone);
}

export type ReportPeriodChoice = 7 | 30;

/** The selected report option as a fresh period, so a period change and a refresh cannot reuse stale bounds. */
export function reportPeriod(choice: ReportPeriodChoice, now = new Date(), zone = getWorkspaceTimeZone()): LocalDayPeriod {
  return localDayPeriod(choice, now, zone);
}

const periodDay = (day: string) => new Date(`${day}T12:00:00.000Z`);

/** "30 Oct–5 Nov 2026", always including the year on the end date and both years when they differ. */
export function periodDateLabel(period: Pick<LocalDayPeriod, 'fromDate' | 'toDate'>): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const from = fmt.format(periodDay(period.fromDate));
  const to = fmt.format(periodDay(period.toDate));
  const fromYear = period.fromDate.slice(0, 4);
  const toYear = period.toDate.slice(0, 4);
  return fromYear === toYear ? `${from}–${to} ${toYear}` : `${from} ${fromYear}–${to} ${toYear}`;
}

/** The local calendar date of an ISO instant in `zone`, as YYYY-MM-DD. */
function localDateOfInstant(iso: string, zone: string): string | null {
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

/** Human label for the bounds a read returned, interpreted in that read's zone. */
export function returnedPeriodLabel(from: string | null, to: string | null, zone: string): string | null {
  if (!from || !to) return null;
  const fromDate = localDateOfInstant(from, zone);
  const toDate = localDateOfInstant(to, zone);
  if (!fromDate || !toDate) return null;
  return periodDateLabel({ fromDate, toDate });
}

/** A single day in the report's table and axis labels, e.g. "30 Oct". */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

/** The Analytics link for this period in the shared date-only, inclusive format. */
export function analyticsHrefFor(period: LocalDayPeriod, broadcastId?: string): string {
  const params = new URLSearchParams({ from: period.fromDate, to: period.toDate });
  if (broadcastId) params.set('broadcast', broadcastId);
  return `/insights/analytics?${params.toString()}`;
}
