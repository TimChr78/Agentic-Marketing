import { getWorkspaceTimeZone, wallTimeToIso } from '../../ui/time';

// The last seven complete local calendar days, in the workspace zone (the same period Home uses):
// from local midnight seven days ago inclusive to today's local midnight exclusive. Building each
// boundary with `wallTimeToIso` keeps DST transitions honest.

function localDateParts(date: Date, zone: string): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

export interface LocalDayPeriod {
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  zone: string;
}

export function lastSevenLocalDays(now = new Date(), zone = getWorkspaceTimeZone()): LocalDayPeriod {
  const today = localDateParts(now, zone);
  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const firstUtc = new Date(todayUtc.getTime() - 7 * 86_400_000);
  const fromDate = dateOnly(firstUtc);
  const toDate = dateOnly(todayUtc);
  return {
    from: wallTimeToIso(`${fromDate}T00:00`, zone) ?? `${fromDate}T00:00:00.000Z`,
    to: wallTimeToIso(`${toDate}T00:00`, zone) ?? `${toDate}T00:00:00.000Z`,
    fromDate,
    toDate,
    zone,
  };
}
