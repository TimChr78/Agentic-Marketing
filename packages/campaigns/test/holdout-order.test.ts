import { earlierAssignment } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { assignedTimeBounds } from '../src/campaigns';

describe('holdout report ordering (#944 review)', () => {
  it('finds the time bounds of a population too large to spread into Math.min', () => {
    const base = Date.UTC(2026, 10, 1);
    const people = Array.from({ length: 200_000 }, (_, i) => ({ assignedAt: new Date(base + ((i * 7919) % 200_000) * 1000) }));
    expect(assignedTimeBounds(people)).toEqual({ first: base, last: base + 199_999 * 1000 });
  });

  it('orders two assignments inside one millisecond by their microseconds, then by profile id', () => {
    const control = { profileId: 'prf_b', assignedMicros: 1_794_000_000_123_100n };
    const treatment = { profileId: 'prf_a', assignedMicros: 1_794_000_000_123_900n };
    expect(earlierAssignment(control, treatment)).toBe(true);
    expect(earlierAssignment(treatment, control)).toBe(false);
    const tie = { profileId: 'prf_a', assignedMicros: control.assignedMicros };
    expect(earlierAssignment(tie, control)).toBe(true);
  });
});
