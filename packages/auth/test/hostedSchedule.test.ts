import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { describeHostedSchedule, nextHostedRunAt, parseHostedSchedule } from '../src/hostedSchedule';

// Hosted agent schedules (#258, #86), and the two defects the full-repository audit found in the
// matcher: an hourly schedule that only matched at midnight (#621), and a weekly computation that
// rebuilt a formatter for every minute it scanned (#622).

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe('hosted schedules', () => {
  it('parses and describes the three forms', () => {
    expect(parseHostedSchedule('hourly')).toEqual({ kind: 'hourly', hour: 0, minute: 0 });
    expect(parseHostedSchedule('daily:07:05')).toEqual({ kind: 'daily', hour: 7, minute: 5 });
    expect(parseHostedSchedule('weekly:mon:07:00')).toEqual({ kind: 'weekly', weekday: 'mon', hour: 7, minute: 0 });
    expect(describeHostedSchedule('hourly')).toBe('Every hour');
    expect(describeHostedSchedule('daily:07:05')).toBe('Every day at 07:05');
    expect(describeHostedSchedule('weekly:mon:07:00')).toBe('Every Monday at 07:00');
  });
});

describe('an hourly schedule runs at minute 0 of every hour (#621)', () => {
  it('is not pinned to midnight', () => {
    // The old matcher compared the schedule's hour (0) with the local hour, so this was 15:30 (the
    // one-hour fallback) instead of 15:00.
    expect(nextHostedRunAt('hourly', 'UTC', at('2026-11-08T14:30:00Z'))).toEqual(at('2026-11-08T15:00:00Z'));
    expect(nextHostedRunAt('hourly', 'UTC', at('2026-11-08T00:05:00Z'))).toEqual(at('2026-11-08T01:00:00Z'));
    expect(nextHostedRunAt('hourly', 'UTC', at('2026-11-08T23:50:00Z'))).toEqual(at('2026-11-09T00:00:00Z'));
  });

  it('uses the workspace time zone for the minute-0 boundary', () => {
    // 09:10Z is 14:40 in Kolkata: the next local minute 0 is 15:00 there, 09:30Z.
    expect(nextHostedRunAt('hourly', 'Asia/Kolkata', at('2026-11-08T09:10:00Z'))).toEqual(at('2026-11-08T09:30:00Z'));
  });
});

describe('resolving a wall time around a transition', () => {
  it('finds a valid run on the spring-forward day in New York', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT; 03:30 exists on the 8th at 07:30Z.
    expect(nextHostedRunAt('daily:03:30', 'America/New_York', at('2026-03-07T18:00:00Z'))).toEqual(at('2026-03-08T07:30:00Z'));
  });

  it('takes the first repeated occurrence in a 30-minute DST zone', () => {
    // Lord Howe: 2026-04-05 02:00 LHDT falls back to 01:30 LHST, so 01:45 happens at 14:45Z and
    // 15:15Z. The first is the next run.
    expect(nextHostedRunAt('daily:01:45', 'Australia/Lord_Howe', at('2026-04-04T12:00:00Z'))).toEqual(at('2026-04-04T14:45:00Z'));
    expect(nextHostedRunAt('weekly:sun:01:45', 'Australia/Lord_Howe', at('2026-04-04T12:00:00Z'))).toEqual(at('2026-04-04T14:45:00Z'));
  });

  it('finds the remaining repeated occurrence when now is between the two', () => {
    // New York 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens at 05:30Z and
    // 06:30Z. now (05:45Z) is after the first.
    expect(nextHostedRunAt('daily:01:30', 'America/New_York', at('2026-11-01T05:45:00Z'))).toEqual(at('2026-11-01T06:30:00Z'));
  });
});

// A minute-by-minute reference over the DST weeks of 2026, kept in the test only. It is the
// definition the jump-based implementation must reproduce for every zone, including 30-minute and
// southern-hemisphere transitions.
const REFERENCE_LIMIT = { hourly: 61, daily: 9 * 24 * 60, weekly: 9 * 24 * 60 } as const;

function referenceParts(date: Date, timeZone: string, formatters: Map<string, Intl.DateTimeFormat>) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: get('weekday').toLowerCase().slice(0, 3), hour: Number(get('hour')), minute: Number(get('minute')) };
}

function referenceNext(schedule: string, timeZone: string, now: Date, formatters: Map<string, Intl.DateTimeFormat>): Date {
  const parsed = parseHostedSchedule(schedule);
  let candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < REFERENCE_LIMIT[parsed.kind]; i++) {
    const local = referenceParts(candidate, timeZone, formatters);
    const matches = parsed.kind === 'hourly' ? local.minute === 0 : local.hour === parsed.hour && local.minute === parsed.minute;
    if (matches && (parsed.kind !== 'weekly' || local.weekday === parsed.weekday)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error(`the reference found no ${schedule} run in ${timeZone} after ${now.toISOString()}`);
}

describe('the jump-based computation matches a minute scan across the DST weeks of 2026', () => {
  const zones: { zone: string; transitions: string[] }[] = [
    { zone: 'UTC', transitions: ['2026-03-08', '2026-11-01'] },
    { zone: 'America/New_York', transitions: ['2026-03-08', '2026-11-01'] },
    { zone: 'Europe/London', transitions: ['2026-03-29', '2026-10-25'] },
    { zone: 'Asia/Kolkata', transitions: ['2026-03-29', '2026-10-25'] },
    { zone: 'Australia/Lord_Howe', transitions: ['2026-04-05', '2026-10-04'] },
    { zone: 'Australia/Sydney', transitions: ['2026-04-05', '2026-10-04'] },
    { zone: 'America/Santiago', transitions: ['2026-04-05', '2026-09-06'] },
  ];
  const schedules = ['hourly', 'daily:02:30', 'weekly:sun:02:30'];

  it('agrees on every sampled zone, kind and transition week', () => {
    const formatters = new Map<string, Intl.DateTimeFormat>();
    for (const { zone, transitions } of zones) {
      for (const date of transitions) {
        const day = new Date(`${date}T00:00:00Z`).getTime();
        for (const offset of [-12 * HOUR, 0, 12 * HOUR]) {
          const now = new Date(day + offset);
          for (const schedule of schedules) {
            const expected = referenceNext(schedule, zone, now, formatters);
            const actual = nextHostedRunAt(schedule, zone, now);
            expect(actual, `${schedule} in ${zone} after ${now.toISOString()}`).toEqual(expected);
            expect(actual.getTime()).toBeGreaterThan(now.getTime());
          }
        }
      }
    }
  });
});

describe('computing a weekly run does not scan minutes (#622)', () => {
  it('scales with the number of calls, not with a fresh formatter per scanned minute', () => {
    // A weekly schedule can be seven days out. The old loop built an Intl.DateTimeFormat for every
    // one of up to 11,521 minute candidates (~1 s per call). Each call here is independent, so the
    // work must grow with the number of calls; the absolute ceiling in expectLinear also catches a
    // per-call minute scan. No fixed millisecond limit of our own.
    expectLinear(
      (n) => 'x'.repeat(n),
      (input) => {
        const start = at('2026-11-08T14:30:00Z').getTime();
        for (let i = 0; i < input.length; i++) nextHostedRunAt('weekly:mon:07:00', 'Europe/Stockholm', new Date(start + i * 86_400_000));
      },
      3,
    );
  }, 180_000);
});
