import { describe, expect, it } from 'vitest';
import { analyticsParams, DEFAULT_ANALYTICS_DIMENSIONS, DEFAULT_ANALYTICS_MEASURES } from '../src/pages/insights/analyticsParams';

// Analytics links from Home and the broadcast Report share one date-only, inclusive format. The
// page may only initialise from parameters it can validate; anything else keeps its defaults.

const NOW = new Date('2026-11-06T12:00:00Z');
const broadcast = `bct_${'a'.repeat(32)}`;

describe('Analytics query parameters (#449 review)', () => {
  it('reads a valid range, measures, dimensions and broadcast filter', () => {
    const { params, invalid } = analyticsParams(
      new URLSearchParams({
        from: '2026-10-30',
        to: '2026-11-05',
        measures: 'email.sent,email.delivered',
        dimensions: 'day,broadcast',
        broadcast,
      }),
      NOW,
    );
    expect(invalid).toEqual([]);
    expect(params).toEqual({
      from: '2026-10-30',
      to: '2026-11-05',
      measures: ['email.sent', 'email.delivered'],
      dimensions: ['day', 'broadcast'],
      broadcast,
    });
  });

  it('keeps the page defaults when no parameters are present', () => {
    const { params, invalid } = analyticsParams(new URLSearchParams(), NOW);
    expect(invalid).toEqual([]);
    expect(params).toEqual({
      from: '2026-10-08',
      to: '2026-11-06',
      measures: DEFAULT_ANALYTICS_MEASURES,
      dimensions: DEFAULT_ANALYTICS_DIMENSIONS,
      broadcast: null,
    });
  });

  it('rejects malformed dates, unknown measures/dimensions and a foreign broadcast id', () => {
    const { params, invalid } = analyticsParams(
      new URLSearchParams({
        from: '2026-13-01',
        to: 'yesterday',
        measures: 'email.sent,not.a.measure',
        dimensions: 'day,not-a-dimension',
        broadcast: 'eml_not_a_broadcast',
      }),
      NOW,
    );
    expect(invalid).toEqual(['from/to', 'measures', 'dimensions', 'broadcast']);
    expect(params).toEqual({
      from: '2026-10-08',
      to: '2026-11-06',
      measures: DEFAULT_ANALYTICS_MEASURES,
      dimensions: DEFAULT_ANALYTICS_DIMENSIONS,
      broadcast: null,
    });
  });

  it('rejects a reversed range', () => {
    const { params, invalid } = analyticsParams(new URLSearchParams({ from: '2026-11-05', to: '2026-10-30' }), NOW);
    expect(invalid).toEqual(['from/to']);
    expect(params.from).toBe('2026-10-08');
    expect(params.to).toBe('2026-11-06');
  });
});
