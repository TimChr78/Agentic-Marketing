import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { describeHostedSchedule, nextHostedRunAt, parseHostedSchedule } from '../src/hostedSchedule';

// Hosted agent schedules (#258, #86), and the two defects the full-repository audit found in the
// matcher: an hourly schedule that only matched at midnight (#621), and a weekly computation that
// rebuilt a formatter for every minute it scanned (#622).

const at = (iso: string) => new Date(iso);

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

describe('daylight-saving transitions', () => {
  // Europe/Stockholm: 2026-03-29 02:00 CET jumps to 03:00 CEST, so 02:30 does not exist that day.
  it('uses the next matching day when a local time is skipped', () => {
    expect(nextHostedRunAt('daily:02:30', 'Europe/Stockholm', at('2026-03-28T12:00:00Z'))).toEqual(at('2026-03-30T00:30:00Z'));
  });

  // 2026-10-25 03:00 CEST falls back to 02:00 CET: 02:30 happens twice, at 00:30Z and 01:30Z.
  it('takes the first occurrence when a local time repeats', () => {
    expect(nextHostedRunAt('daily:02:30', 'Europe/Stockholm', at('2026-10-24T12:00:00Z'))).toEqual(at('2026-10-25T00:30:00Z'));
  });

  it('keeps a weekly schedule on its local weekday across a transition', () => {
    // Sunday 2026-03-29 07:00 CEST (05:00Z) is the first matching time after Saturday.
    expect(nextHostedRunAt('weekly:sun:07:00', 'Europe/Stockholm', at('2026-03-28T12:00:00Z'))).toEqual(at('2026-03-29T05:00:00Z'));
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
