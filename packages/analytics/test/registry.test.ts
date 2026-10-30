import { describe, expect, it } from 'vitest';
import { commonDimensions, DIMENSIONS, MEASURES, METRIC_CATALOG, measureIds, TIME_DIMENSIONS } from '../src/registry';

// The catalogue is the only thing the query surface accepts, so these tests pin the invariants the
// compiler and the UI rely on rather than the exact list of measures (which changes as the product
// grows).

const ALL_MEASURES = Object.values(MEASURES);

describe('metric registry', () => {
  it('keys every measure by its own id, exactly once', () => {
    for (const [key, measure] of Object.entries(MEASURES)) expect(measure.id).toBe(key);
    const ids = measureIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ALL_MEASURES.map((m) => m.id));
  });

  it('gives every measure a non-empty description and a known unit', () => {
    for (const measure of ALL_MEASURES) {
      expect(measure.description.length).toBeGreaterThan(0);
      expect(['count', 'ratio', 'currency']).toContain(measure.unit);
      expect(measure.source).toMatch(/^(message_events|journey_events|events|segment_memberships|campaign)$/);
    }
  });

  it('resolves every dimension a measure offers to a dimension definition', () => {
    for (const measure of ALL_MEASURES) {
      expect(measure.dimensions.length).toBeGreaterThan(0);
      for (const dimension of measure.dimensions) expect(DIMENSIONS[dimension]?.id).toBe(dimension);
    }
  });

  it('builds ratio measures from existing base measures of the same source', () => {
    for (const measure of ALL_MEASURES) {
      if (measure.kind !== 'ratio') continue;
      for (const id of [measure.numerator, measure.denominator]) {
        const base = MEASURES[id];
        expect(base, `${measure.id} refers to ${id}`).toBeDefined();
        expect(base?.kind).toBe('base');
        expect(base?.source).toBe(measure.source);
      }
      expect(measure.aggregation).toBe('ratio');
    }
  });

  it('pins ratio units: rates are ratios, revenue per recipient is money', () => {
    const ratioUnits = ALL_MEASURES.filter((m) => m.kind === 'ratio' && m.unit !== 'ratio').map((m) => m.id);
    expect(ratioUnits).toEqual(['campaign.revenue_per_recipient']);
    expect(MEASURES['campaign.revenue_per_recipient']?.unit).toBe('currency');
  });

  it('keeps every default grain among the dimensions the measure supports', () => {
    for (const measure of ALL_MEASURES) {
      if (measure.defaultGrain === null) continue;
      expect(measure.dimensions).toContain(measure.defaultGrain);
    }
    expect(MEASURES['segment.members']?.defaultGrain).toBeNull();
  });

  it('marks exactly day, week and month as time dimensions', () => {
    const time = Object.values(DIMENSIONS)
      .filter((d) => d.time)
      .map((d) => d.id);
    expect(new Set(time)).toEqual(TIME_DIMENSIONS);
    expect([...TIME_DIMENSIONS]).toEqual(['day', 'week', 'month']);
  });

  it('keys every dimension by its own id and lists at least one source', () => {
    for (const [key, dimension] of Object.entries(DIMENSIONS)) {
      expect(dimension.id).toBe(key);
      expect(dimension.description.length).toBeGreaterThan(0);
      expect(dimension.sources.length).toBeGreaterThan(0);
    }
  });

  it('lists every source a measure offers in the dimension catalogue (#173)', () => {
    // The catalogue told clients day/week/month do not apply to campaign measures, which offer them.
    const missing: string[] = [];
    for (const measure of ALL_MEASURES)
      for (const dimension of measure.dimensions)
        if (!DIMENSIONS[dimension].sources.includes(measure.source)) missing.push(`${measure.id} × ${dimension}`);
    expect(missing).toEqual([]);
  });

  it('exposes the public catalogue as a mirror of the internal registry', () => {
    expect(METRIC_CATALOG.measures.map((m) => m.id)).toEqual(measureIds());
    for (const [i, measure] of ALL_MEASURES.entries()) {
      const entry = METRIC_CATALOG.measures[i];
      expect(entry).toMatchObject({
        id: measure.id,
        unit: measure.unit,
        aggregation: measure.aggregation,
        source: measure.source,
        defaultGrain: measure.defaultGrain,
        kind: measure.kind,
      });
      expect(entry?.dimensions).toEqual([...measure.dimensions]);
      if (measure.kind === 'ratio') expect(entry).toMatchObject({ numerator: measure.numerator, denominator: measure.denominator });
    }
    expect(METRIC_CATALOG.dimensions.map((d) => d.id)).toEqual(Object.keys(DIMENSIONS));
    for (const entry of METRIC_CATALOG.dimensions)
      expect(entry.sources).toEqual([...DIMENSIONS[entry.id as keyof typeof DIMENSIONS].sources]);
  });

  it('computes the dimensions a set of measures shares', () => {
    expect(commonDimensions([])).toEqual([]);
    expect(commonDimensions([MEASURES['email.sent']!])).toEqual([...MEASURES['email.sent']!.dimensions]);

    const shared = commonDimensions([MEASURES['email.sent']!, MEASURES['email.click_rate']!]);
    expect(shared).toContain('day');
    expect(shared).toContain('template');
    expect(shared).toEqual(commonDimensions([MEASURES['email.click_rate']!, MEASURES['email.sent']!]));
  });

  it('only shares time dimensions between e-mail and journey measures', () => {
    const shared = commonDimensions([MEASURES['email.sent']!, MEASURES['journey.entered']!]);
    expect(shared).toEqual(['day', 'week', 'month', 'journey', 'campaign']);
    expect(commonDimensions([MEASURES['email.sent']!, MEASURES['segment.members']!])).toEqual([]);
  });
});
