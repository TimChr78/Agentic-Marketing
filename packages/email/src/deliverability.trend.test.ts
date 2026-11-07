import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { trendBoundaries, trendPoints } from './policy';

// B5 (Phase 26, #508): local daily boundaries and the rolling creation-window roll-up. The
// database read is covered by apps/server/test/v026-deliverability-trend.test.ts.

const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000);

describe('deliverability trend boundaries', () => {
  it('rejects an empty or reversed range', () => {
    expect(() => trendBoundaries(new Date('2026-11-07T00:00:00Z'), new Date('2026-11-07T00:00:00Z'), 'UTC')).toThrow(AppError);
    expect(() => trendBoundaries(new Date('2026-11-08T00:00:00Z'), new Date('2026-11-07T00:00:00Z'), 'UTC')).toThrow(/before/);
  });

  it('caps the answer at 90 daily points', () => {
    expect(() => trendBoundaries(new Date('2026-01-01T00:00:00Z'), new Date('2026-04-02T00:00:00Z'), 'UTC')).toThrow(/at most 90/);
    const ninety = trendBoundaries(new Date('2026-01-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'), 'UTC');
    expect(ninety).toHaveLength(90);
  });

  it('labels each point with the local day that ended at its midnight', () => {
    const points = trendBoundaries(new Date('2026-11-04T00:00:00Z'), new Date('2026-11-07T00:00:00Z'), 'UTC');
    expect(points.map((p) => p.day)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(points.map((p) => p.windowTo.toISOString())).toEqual([
      '2026-11-05T00:00:00.000Z',
      '2026-11-06T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
    ]);
  });

  it('ends at local midnight in the workspace zone', () => {
    // Copenhagen is UTC+2 until the fall-back on 2026-10-25, then UTC+1.
    const points = trendBoundaries(new Date('2026-10-23T22:00:00Z'), new Date('2026-10-26T23:00:00Z'), 'Europe/Copenhagen');
    expect(points.map((p) => p.day)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(points.map((p) => p.windowTo.toISOString())).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
      '2026-10-26T23:00:00.000Z',
    ]);
  });

  it('keeps the rolling window a fixed duration across daylight saving', () => {
    const points = trendBoundaries(new Date('2026-10-24T22:00:00Z'), new Date('2026-10-25T23:00:00Z'), 'Europe/Copenhagen');
    expect(points).toHaveLength(1);
    const point = points[0]!;
    expect(point.day).toBe('2026-10-25');
    expect(point.windowTo.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // Seven local calendar days would start at 2026-10-18T22:00Z (local midnight, CEST). The policy
    // window is 7 * 86_400_000 ms, so it starts one hour later, at 23:00Z.
    expect(new Date(point.windowTo.getTime() - 7 * 86_400_000).toISOString()).toBe('2026-10-18T23:00:00.000Z');
  });
});

describe('deliverability trend points', () => {
  const boundary = (day: string, windowTo: string) => ({ day, windowTo: new Date(windowTo) });

  it('sums current statuses over the rolling window', () => {
    const points = trendPoints([boundary('2026-01-02', '2026-01-03T00:00:00Z')], 1, [
      { minute: minute('2026-01-02T10:00:00Z'), status: 'delivered', n: 3 },
      { minute: minute('2026-01-02T10:01:00Z'), status: 'bounced', n: 1 },
      { minute: minute('2026-01-02T10:02:00Z'), status: 'complained', n: 1 },
      { minute: minute('2026-01-02T10:03:00Z'), status: 'sent', n: 2 },
      // Before the fixed 24-hour window: excluded.
      { minute: minute('2026-01-01T23:59:00Z'), status: 'bounced', n: 9 },
      // At the exclusive end boundary: excluded.
      { minute: minute('2026-01-03T00:00:00Z'), status: 'bounced', n: 9 },
    ]);
    expect(points[0]).toMatchObject({
      day: '2026-01-02',
      windowFrom: '2026-01-02T00:00:00.000Z',
      windowTo: '2026-01-03T00:00:00.000Z',
      sent: 7,
      bounced: 1,
      complained: 1,
    });
    expect(points[0]!.bounceRate).toBeCloseTo(1 / 7);
    expect(points[0]!.complaintRate).toBeCloseTo(1 / 7);
  });

  it('returns null rates when the denominator is zero', () => {
    const points = trendPoints([boundary('2026-01-02', '2026-01-03T00:00:00Z')], 7, []);
    expect(points[0]).toMatchObject({ sent: 0, bounced: 0, complained: 0, bounceRate: null, complaintRate: null });
  });

  it('keeps computed rates for a low-volume point; the surface withholds them', () => {
    const points = trendPoints([boundary('2026-01-02', '2026-01-03T00:00:00Z')], 7, [
      { minute: minute('2026-01-02T10:00:00Z'), status: 'bounced', n: 1 },
    ]);
    expect(points[0]).toMatchObject({ sent: 1, bounced: 1 });
    expect(points[0]!.bounceRate).toBe(1);
  });

  it('rolls a fixed window forward without recounting older buckets', () => {
    const points = trendPoints([boundary('2026-01-02', '2026-01-03T00:00:00Z'), boundary('2026-01-03', '2026-01-04T00:00:00Z')], 1, [
      { minute: minute('2026-01-02T12:00:00Z'), status: 'delivered', n: 2 },
      { minute: minute('2026-01-03T12:00:00Z'), status: 'delivered', n: 3 },
    ]);
    expect(points.map((p) => p.sent)).toEqual([2, 3]);
  });

  it('uses the same fixed 168-hour window on both sides of a fall-back', () => {
    const points = trendBoundaries(new Date('2026-10-24T22:00:00Z'), new Date('2026-10-25T23:00:00Z'), 'Europe/Copenhagen');
    const rows = [
      // 2026-10-18T22:30Z is after local midnight (00:30 CEST) but before the fixed window (23:00Z).
      { minute: minute('2026-10-18T22:30:00Z'), status: 'delivered', n: 4 },
      { minute: minute('2026-10-18T23:30:00Z'), status: 'delivered', n: 1 },
    ] as const;
    const result = trendPoints(points, 7, [...rows]);
    expect(result[0]).toMatchObject({ sent: 1 });
  });
});
