import { describe, expect, it } from 'vitest';
import { isoToWallTime, wallTimeToIso, zoneOffsetMinutes } from '../src/ui/time';

describe('workspace time zone helpers (#51)', () => {
  it('turns a wall time in the workspace zone into ISO 8601 with the right offset, across DST', () => {
    expect(wallTimeToIso('2026-07-01T09:00', 'Europe/Copenhagen')).toBe('2026-07-01T09:00:00+02:00');
    expect(wallTimeToIso('2026-12-01T09:00', 'Europe/Copenhagen')).toBe('2026-12-01T09:00:00+01:00');
    expect(wallTimeToIso('2026-10-30T09:00', 'America/New_York')).toBe('2026-10-30T09:00:00-04:00');
    expect(wallTimeToIso('2026-10-30T09:00', 'UTC')).toBe('2026-10-30T09:00:00+00:00');
    expect(wallTimeToIso('not a date', 'UTC')).toBeNull();
  });

  it('shows a stored UTC instant as wall time in the zone, and round-trips', () => {
    expect(isoToWallTime('2026-10-30T08:00:00.000Z', 'Europe/Copenhagen')).toBe('2026-10-30T09:00');
    const iso = wallTimeToIso('2026-03-29T12:30', 'Europe/Copenhagen')!;
    expect(isoToWallTime(new Date(iso).toISOString(), 'Europe/Copenhagen')).toBe('2026-03-29T12:30');
    expect(isoToWallTime(null)).toBe('');
  });

  it('knows zone offsets', () => {
    expect(zoneOffsetMinutes('Asia/Kolkata', Date.UTC(2026, 0, 1))).toBe(330);
  });
});
