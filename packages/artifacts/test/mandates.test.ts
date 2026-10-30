import { describe, expect, it } from 'vitest';
import { outsideWorkingHours } from '../src/mandates';

// Mandate working hours in the workspace time zone (#223), including overnight windows (#233).

const at = (iso: string) => new Date(iso);

describe('mandate working hours', () => {
  const daytime = { workingHours: { start: '07:00', end: '11:00', days: ['tue' as const] }, blackoutDates: [] };

  it('allows a daytime window on its day only', () => {
    expect(outsideWorkingHours(daytime, 'UTC', at('2026-11-03T08:00:00Z'))).toBeNull(); // Tuesday 08:00
    expect(outsideWorkingHours(daytime, 'UTC', at('2026-11-03T12:00:00Z'))).toContain('between 07:00 and 11:00');
    expect(outsideWorkingHours(daytime, 'UTC', at('2026-11-04T08:00:00Z'))).toContain('tue'); // Wednesday
  });

  it('counts the part of an overnight window after midnight to the day it started (#233)', () => {
    const monNight = { workingHours: { start: '22:00', end: '02:00', days: ['mon' as const] }, blackoutDates: [] };
    expect(outsideWorkingHours(monNight, 'UTC', at('2026-11-02T23:00:00Z'))).toBeNull(); // Monday 23:00
    expect(outsideWorkingHours(monNight, 'UTC', at('2026-11-03T01:00:00Z'))).toBeNull(); // Tuesday 01:00, Monday's window
    expect(outsideWorkingHours(monNight, 'UTC', at('2026-11-02T01:00:00Z'))).toContain('mon'); // Monday 01:00 is Sunday's window
    expect(outsideWorkingHours(monNight, 'UTC', at('2026-11-03T03:00:00Z'))).toContain('between 22:00 and 02:00');
  });

  it('uses the workspace time zone', () => {
    const monNight = { workingHours: { start: '22:00', end: '02:00', days: ['mon' as const] }, blackoutDates: [] };
    // 23:30 UTC on Monday is 00:30 on Tuesday in Stockholm (CET): still Monday's window.
    expect(outsideWorkingHours(monNight, 'Europe/Stockholm', at('2026-11-02T23:30:00Z'))).toBeNull();
    // 00:30 UTC on Monday is 01:30 on Monday in Stockholm: Sunday's window.
    expect(outsideWorkingHours(monNight, 'Europe/Stockholm', at('2026-11-02T00:30:00Z'))).toContain('mon');
  });

  it('blocks blackout dates in the workspace time zone', () => {
    const m = { blackoutDates: ['2026-12-24'] };
    expect(outsideWorkingHours(m, 'UTC', at('2026-12-24T10:00:00Z'))).toContain('blackout');
    expect(outsideWorkingHours(m, 'UTC', at('2026-12-23T10:00:00Z'))).toBeNull();
  });
});
