// Hosted agent schedules (#258, #86). Deliberately small and strict instead of a general cron:
// three forms, read in the workspace's IANA time zone.
//
//   hourly            every hour, at minute 0
//   daily:07:00       every day at 07:00 local time
//   weekly:mon:07:00  every Monday at 07:00 local time
//
// Days are three letters: mon, tue, wed, thu, fri, sat, sun. Times are 24-hour HH:MM with two
// digits. Anything else is refused when the hosted agent is created or changed.

import { zonedParts } from '@agentic-marketing/core';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type HostedWeekday = (typeof DAYS)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

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

/**
 * A zone's offset from UTC at `at`, in milliseconds. `zonedParts` caches its formatter, so this
 * stays cheap even when called a handful of times per scheduled day.
 */
function offsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(at.getTime() / MINUTE) * MINUTE;
}

/**
 * The earliest instant at or after `from` whose wall clock in `timeZone` is the named minute, or
 * null when that wall-clock time does not exist (a daylight-saving spring-forward).
 *
 * Resolving a wall time needs the zone offset, and the offset is exactly what changes at a
 * transition. The standard two-pass method reads the offset at the target interpreted as UTC,
 * subtracts it, then re-reads the offset at that candidate. Probing 24 hours before and after as
 * well brackets both sides of any transition (30 minutes, 1 hour, 2 hours), so the candidates
 * include every instant that really maps back to the wall time. A repeated time keeps the earliest
 * that is not before `from`; a skipped one has no candidate, so the caller moves to the next day.
 */
function localMinute(y: number, m: number, d: number, hour: number, minute: number, timeZone: string, from: Date): Date | null {
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  const offsets = new Set<number>();
  for (const shift of [-DAY_MS, 0, DAY_MS]) {
    const first = offsetMs(new Date(wanted + shift), timeZone);
    offsets.add(first);
    offsets.add(offsetMs(new Date(wanted - first), timeZone));
  }
  let best: Date | null = null;
  for (const offset of offsets) {
    const candidate = new Date(wanted - offset);
    if (candidate.getTime() < from.getTime()) continue;
    const p = zonedParts(candidate, timeZone);
    if (p.y !== y || p.m !== m || p.d !== d || p.h !== hour || p.min !== minute) continue;
    if (!best || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best;
}

/**
 * The first minute after `now` that matches the schedule in `timeZone`. When a local time is
 * skipped by a daylight-saving jump the next matching day is used; when it repeats, the first
 * occurrence wins.
 *
 * The next run is found by jumping: an hourly schedule jumps to the next local minute 0, and a
 * daily or weekly one tries at most the next eight local dates. No minute-by-minute scan, and no
 * formatter constructed per candidate (#622).
 */
export function nextHostedRunAt(schedule: string | HostedSchedule, timeZone: string, now = new Date()): Date {
  const parsed = typeof schedule === 'string' ? parseHostedSchedule(schedule) : schedule;
  const from = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE + MINUTE);
  if (parsed.kind === 'hourly') {
    let candidate = from;
    // Wall-clock minutes normally advance with UTC. A daylight-saving change can move the boundary
    // by up to an hour, so re-check after the jump rather than trusting a single subtraction.
    for (let i = 0; i < 4; i++) {
      const jump = (60 - zonedParts(candidate, timeZone).min) % 60;
      if (jump === 0) return candidate;
      candidate = new Date(candidate.getTime() + jump * MINUTE);
    }
    return candidate;
  }
  const p = zonedParts(from, timeZone);
  for (let d = 0; d <= 8; d++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + d));
    if (parsed.kind === 'weekly' && DAYS[day.getUTCDay()] !== parsed.weekday) continue;
    const candidate = localMinute(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      parsed.hour,
      parsed.minute,
      timeZone,
      from,
    );
    if (candidate) return candidate;
  }
  // Unreachable for a valid schedule; a safe retry rather than a crash.
  return new Date(now.getTime() + HOUR);
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
