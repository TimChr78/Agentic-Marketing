// Hosted agent schedules (#258, #86). Deliberately small and strict instead of a general cron:
// three forms, read in the workspace's IANA time zone.
//
//   hourly            every hour, at minute 0
//   daily:07:00       every day at 07:00 local time
//   weekly:mon:07:00  every Monday at 07:00 local time
//
// Days are three letters: mon, tue, wed, thu, fri, sat, sun. Times are 24-hour HH:MM with two
// digits. Anything else is refused when the hosted agent is created or changed.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type HostedWeekday = (typeof DAYS)[number];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^(mon|tue|wed|thu|fri|sat|sun)$/;

export interface HostedSchedule {
  kind: 'hourly' | 'daily' | 'weekly';
  /** Present for weekly schedules. */
  weekday?: HostedWeekday;
  /** Local hour (0–23) and minute (0–59). */
  hour: number;
  minute: number;
}

export function parseHostedSchedule(value: string): HostedSchedule {
  const schedule = value.trim().toLowerCase();
  if (schedule === 'hourly') return { kind: 'hourly', hour: 0, minute: 0 };
  const daily = /^daily:(.+)$/.exec(schedule);
  if (daily) {
    const time = TIME.exec(daily[1] ?? '');
    if (!time) throw new Error('A daily schedule looks like daily:07:00 (24-hour HH:MM).');
    return { kind: 'daily', hour: Number(time[1]), minute: Number(time[2]) };
  }
  const weekly = /^weekly:([^:]+):(.+)$/.exec(schedule);
  if (weekly) {
    const weekday = weekly[1] ?? '';
    const time = TIME.exec(weekly[2] ?? '');
    if (!DAY.test(weekday)) throw new Error('A weekly schedule looks like weekly:mon:07:00 (mon, tue, wed, thu, fri, sat or sun).');
    if (!time) throw new Error('A weekly schedule looks like weekly:mon:07:00 (24-hour HH:MM).');
    return { kind: 'weekly', weekday: weekday as HostedWeekday, hour: Number(time[1]), minute: Number(time[2]) };
  }
  throw new Error('The schedule must be hourly, daily:HH:MM or weekly:day:HH:MM (e.g. weekly:mon:07:00).');
}

export function isValidHostedSchedule(value: string): boolean {
  try {
    parseHostedSchedule(value);
    return true;
  } catch {
    return false;
  }
}

/** The day, hour and minute of `date` in `timeZone`. */
function localParts(date: Date, timeZone: string): { weekday: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday').toLowerCase().slice(0, 3),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function matches(schedule: HostedSchedule, local: { weekday: string; hour: number; minute: number }): boolean {
  if (local.hour !== schedule.hour || local.minute !== schedule.minute) return false;
  return schedule.kind !== 'weekly' || local.weekday === schedule.weekday;
}

/** How far ahead to look: a weekly schedule can be nearly eight days away. */
const LIMIT_MINUTES = { hourly: 61, daily: 26 * 60 + 1, weekly: 8 * 24 * 60 + 1 } as const;

/**
 * The first minute after `now` that matches the schedule in `timeZone`. When a local time is
 * skipped by a daylight-saving jump the next matching day is used; when it repeats, the first
 * occurrence wins.
 */
export function nextHostedRunAt(schedule: string | HostedSchedule, timeZone: string, now = new Date()): Date {
  const parsed = typeof schedule === 'string' ? parseHostedSchedule(schedule) : schedule;
  let candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < LIMIT_MINUTES[parsed.kind]; i++) {
    if (matches(parsed, localParts(candidate, timeZone))) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  // Unreachable for a valid schedule; a safe retry rather than a crash.
  return new Date(now.getTime() + 60 * 60_000);
}

const DAY_LABEL: Record<HostedWeekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/** A short sentence for the UI and the docs. */
export function describeHostedSchedule(value: string): string {
  const s = parseHostedSchedule(value);
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.kind === 'hourly') return 'Every hour';
  if (s.kind === 'daily') return `Every day at ${time}`;
  return `Every ${DAY_LABEL[s.weekday ?? 'mon']} at ${time}`;
}
