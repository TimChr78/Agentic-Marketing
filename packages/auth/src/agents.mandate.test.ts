import { describe, expect, it } from 'vitest';
import { outsideWorkingHours } from '../../artifacts/src/mandates';

// B6 (Phase 26, #509): agents.mandate must report the same working-hours verdict the policy
// engine uses. The selection of the published, unarchived, unexpired mandate is covered against
// Postgres in apps/server/test/v026-agent-mandate.test.ts.

const at = (iso: string) => new Date(iso);

describe('agents.mandate working hours', () => {
  it('is inside a daytime window on its day only', () => {
    const mandate = { workingHours: { start: '07:00', end: '11:00', days: ['tue' as const] }, blackoutDates: [] };
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-03T08:00:00Z'))).toBeNull();
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-03T12:00:00Z'))).toContain('between 07:00 and 11:00');
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-04T08:00:00Z'))).toContain('tue');
  });

  it('counts the after-midnight part of an overnight window to the day it started', () => {
    const mandate = { workingHours: { start: '22:00', end: '02:00', days: ['mon' as const] }, blackoutDates: [] };
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-02T23:00:00Z'))).toBeNull();
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-03T01:00:00Z'))).toBeNull();
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-02T01:00:00Z'))).toContain('mon');
    expect(outsideWorkingHours(mandate, 'UTC', at('2026-11-03T03:00:00Z'))).toContain('between 22:00 and 02:00');
  });

  it('uses the workspace zone across a fall-back transition', () => {
    // Copenhagen falls back on 2026-10-25. 01:30Z is 03:30 CEST on Saturday but 02:30 CET on Sunday.
    const mandate = { workingHours: { start: '02:00', end: '03:00', days: ['sat' as const, 'sun' as const] }, blackoutDates: [] };
    expect(outsideWorkingHours(mandate, 'Europe/Copenhagen', at('2026-10-24T01:30:00Z'))).toContain('between 02:00 and 03:00');
    expect(outsideWorkingHours(mandate, 'Europe/Copenhagen', at('2026-10-25T01:30:00Z'))).toBeNull();
  });

  it('uses the workspace zone across a spring-forward transition', () => {
    // Copenhagen jumps 02:00 CET -> 03:00 CEST on 2026-03-29. 01:30Z is 03:30 CEST, inside the window.
    const mandate = { workingHours: { start: '02:30', end: '04:00', days: ['sun' as const] }, blackoutDates: [] };
    expect(outsideWorkingHours(mandate, 'Europe/Copenhagen', at('2026-03-29T00:30:00Z'))).toContain('between 02:30 and 04:00');
    expect(outsideWorkingHours(mandate, 'Europe/Copenhagen', at('2026-03-29T01:30:00Z'))).toBeNull();
  });

  it('blocks a blackout date in the workspace zone', () => {
    expect(outsideWorkingHours({ blackoutDates: ['2026-12-24'] }, 'UTC', at('2026-12-24T10:00:00Z'))).toContain('blackout');
    expect(outsideWorkingHours({ blackoutDates: ['2026-12-24'] }, 'UTC', at('2026-12-23T10:00:00Z'))).toBeNull();
  });
});
