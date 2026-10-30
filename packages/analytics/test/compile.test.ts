import { describe, expect, it } from 'vitest';
import {
  type BuildInput,
  buildQuery,
  type ConversionRule,
  dimensionExpression,
  invalidDimensionMessage,
  revenueExpressions,
} from '../src/compile';
import { MEASURES, type MeasureDef } from '../src/registry';

const measure = (id: string): MeasureDef => {
  const found = MEASURES[id];
  if (!found) throw new Error(`no measure ${id}`);
  return found;
};

const input = (overrides: Partial<BuildInput> = {}): BuildInput => ({
  workspaceId: 'ws_01',
  measures: [measure('email.sent')],
  dimensions: [],
  source: 'message_events',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
  timeZone: 'Europe/Copenhagen',
  filters: {},
  limit: 100,
  conversionRules: [],
  conversionNames: [],
  ...overrides,
});

const ratio = (overrides: Partial<Extract<MeasureDef, { kind: 'ratio' }>> = {}): MeasureDef => ({
  kind: 'ratio',
  id: 'fake.rate',
  description: 'A fabricated rate',
  unit: 'ratio',
  source: 'message_events',
  aggregation: 'ratio',
  numerator: 'email.clicked',
  denominator: 'email.delivered',
  dimensions: ['day'],
  defaultGrain: 'day',
  ...overrides,
});

describe('query compiler', () => {
  it('compiles a per-day count into one parameterised ClickHouse query', () => {
    const compiled = buildQuery(input({ dimensions: ['day'] }));

    expect(compiled.sql).toContain('FROM message_events FINAL');
    expect(compiled.sql).toContain('workspace_id = {ws:UUID}');
    expect(compiled.sql).toContain("at >= {from:DateTime64(3, 'UTC')}");
    expect(compiled.sql).toContain("at <= {to:DateTime64(3, 'UTC')}");
    expect(compiled.sql).toContain('type IN {types:Array(String)}');
    expect(compiled.sql).toContain("GROUP BY formatDateTime(toStartOfDay(at, {tz:String}), '%Y-%m-%d')");
    expect(compiled.sql).toContain('LIMIT {limit:UInt32}');
    expect(compiled.sql.startsWith('SELECT ')).toBe(true);
    expect(compiled.sql).toContain("uniqExactIf(profile_id, profile_id != '' AND (type = 'sent')) AS base_email_sent");
    expect(compiled.sql).toContain("formatDateTime(toStartOfDay(at, {tz:String}), '%Y-%m-%d') AS dim_day");

    expect(compiled.params).toMatchObject({
      ws: 'ws_01',
      tz: 'Europe/Copenhagen',
      from: '2026-10-01T00:00:00.000',
      to: '2026-10-02T00:00:00.000',
      limit: 100,
      types: ['sent'],
    });
    expect(compiled.columns).toEqual([
      { name: 'day', kind: 'dimension' },
      { name: 'email.sent', kind: 'measure', unit: 'count' },
    ]);
    expect(compiled.outputs).toEqual([
      { kind: 'dimension', dimension: 'day', alias: 'dim_day' },
      { kind: 'measure', measure: MEASURES['email.sent'], alias: 'measure_email_sent' },
    ]);
    expect(compiled.kAlias).toBe('k_group');
    expect(compiled.hasNonTimeDimension).toBe(false);
    expect(compiled.revenue).toBe(false);
  });

  it('strips only the trailing Z from date-time bounds and keeps an explicit offset', () => {
    const compiled = buildQuery(input({ from: '2026-10-01T00:00:00+02:00', to: '2026-10-01T12:00:00.500Z' }));
    expect(compiled.params.from).toBe('2026-10-01T00:00:00+02:00');
    expect(compiled.params.to).toBe('2026-10-01T12:00:00.500');
  });

  it('counts only the event types the requested measures name', () => {
    const compiled = buildQuery(input({ measures: [measure('email.sent'), measure('email.delivered'), measure('email.bounced')] }));
    expect(compiled.params.types).toEqual(['sent', 'delivered', 'bounced']);
  });

  it('aggregates ratio bases in the inner query and divides them outside, null on a zero denominator', () => {
    const compiled = buildQuery(input({ measures: [measure('email.click_rate')], dimensions: ['template'] }));

    expect(compiled.sql).toContain(
      'if(base_email_delivered = 0, NULL, base_email_clicked / base_email_delivered) AS measure_email_click_rate',
    );
    expect(compiled.params.types).toEqual(['clicked', 'delivered']);
    expect(compiled.columns).toEqual([
      { name: 'template', kind: 'dimension' },
      { name: 'email.click_rate', kind: 'measure', unit: 'ratio' },
    ]);
    expect(compiled.outputs[1]).toMatchObject({
      kind: 'measure',
      alias: 'measure_email_click_rate',
      numeratorAlias: 'base_email_clicked',
      denominatorAlias: 'base_email_delivered',
    });
  });

  it('shares a base measure between an explicit base and a ratio instead of counting it twice', () => {
    const compiled = buildQuery(input({ measures: [measure('email.clicked'), measure('email.click_rate')] }));
    expect(compiled.sql.match(/AS base_email_clicked/g)).toHaveLength(1);
    expect(compiled.params.types).toEqual(['clicked', 'delivered']);
  });

  it('lets a measure choose a narrower dimension list', () => {
    const journey = buildQuery(
      input({
        source: 'journey_events',
        measures: [measure('journey.entered')],
        dimensions: ['journey_step'],
        order: { by: 'journey_step', dir: 'asc' },
      }),
    );
    expect(journey.sql).toContain('FROM journey_events FINAL');
    expect(journey.sql).toContain('node AS dim_journey_step');
    expect(journey.sql).toContain('min(seq) AS sort_key');
    expect(journey.sql).toContain('ORDER BY sort_key ASC');
    expect(journey.hasNonTimeDimension).toBe(true);
  });

  it('applies the filters that belong to the source and ignores the others', () => {
    const compiled = buildQuery(
      input({
        filters: { template: ['eml_a'], channel: ['email'], purpose: ['marketing_email'], name: ['Order Completed'] },
      }),
    );
    expect(compiled.params.filter_template).toEqual(['eml_a']);
    expect(compiled.params.filter_channel).toEqual(['email']);
    expect(compiled.params.filter_purpose).toEqual(['marketing_email']);
    expect(compiled.sql).toContain('template_id IN {filter_template:Array(String)}');
    expect(compiled.sql).toContain('channel IN {filter_channel:Array(String)}');
    expect(compiled.params.name).toBeUndefined();
    expect(compiled.sql).not.toContain('filter_name');
  });

  it('sends campaigns to ClickHouse as bounded member arrays, never as cmp_ ids', () => {
    const campaignMap = { memberIds: ['bct_a', 'jrn_b'], memberCampaignIds: ['cmp_one', 'cmp_one'] };
    const compiled = buildQuery(input({ dimensions: ['campaign'], filters: { campaign: ['cmp_one'] }, campaignMap }));

    expect(compiled.params.campaign_map_members).toEqual(campaignMap.memberIds);
    expect(compiled.params.campaign_map_ids).toEqual(campaignMap.memberCampaignIds);
    expect(compiled.params.filter_campaign).toEqual(campaignMap.memberIds);
    expect(compiled.sql).toContain('arrayElement({campaign_map_ids:Array(String)}');
    expect(compiled.sql).toContain('journey_id IN {filter_campaign:Array(String)}');
    expect(compiled.params.filter_campaign).not.toContain('cmp_one');
  });

  it('defaults the campaign arrays to empty when no map is supplied', () => {
    const compiled = buildQuery(input({ dimensions: ['campaign'] }));
    expect(compiled.params.campaign_map_members).toEqual([]);
    expect(compiled.params.campaign_map_ids).toEqual([]);
  });

  it('orders broadcasts by their first send when the caller asks for a broadcast order', () => {
    const compiled = buildQuery(input({ dimensions: ['broadcast'], order: { by: 'broadcast', dir: 'desc' } }));
    expect(compiled.sql).toContain('min(at) AS sort_key');
    expect(compiled.sql).toContain('ORDER BY sort_key DESC, dim_broadcast ASC');
    expect(compiled.hasNonTimeDimension).toBe(true);
  });

  it.fails('defaults a broadcast breakdown to the newest issue by first send (#173)', () => {
    // compile.ts documents "Broadcast defaults to newest first, which is what people mean by the
    // last four issues", and prefers `dir: desc` for it, but the `min(at)` sort key is only added
    // when `input.order` is present. Without an explicit order, LIMIT 4 therefore returns the four
    // highest bct_ ids, not the four latest sends.
    const compiled = buildQuery(input({ dimensions: ['broadcast'], limit: 4 }));
    expect(compiled.sql).toContain('min(at) AS sort_key');
    expect(compiled.sql).toContain('ORDER BY sort_key DESC');
  });

  it.fails('defaults a journey step breakdown to the order the journey reaches its steps (#173)', () => {
    // DIMENSION_SORT gives journey_step `min(seq)`, but like broadcast it is only used for an
    // explicit order.by. The default falls back to the node id, which is not journey order.
    const compiled = buildQuery(input({ source: 'journey_events', measures: [measure('journey.entered')], dimensions: ['journey_step'] }));
    expect(compiled.sql).toContain('min(seq) AS sort_key');
    expect(compiled.sql).toContain('ORDER BY sort_key ASC');
  });

  it('orders by the first measure descending when there is no breakdown', () => {
    const compiled = buildQuery(input());
    expect(compiled.sql).toContain('ORDER BY measure_email_sent DESC');
    expect(compiled.sql).not.toContain('sort_key');
  });

  it('honours an explicit order and keeps the other dimensions as ascending tie-breakers', () => {
    const compiled = buildQuery(
      input({ measures: [measure('email.clicked')], dimensions: ['day', 'channel'], order: { by: 'email.clicked', dir: 'desc' } }),
    );
    expect(compiled.sql).toContain('ORDER BY measure_email_clicked DESC, dim_day ASC, dim_channel ASC');
  });

  it('reads conversion events by name and counts distinct events, with a person-level key for k', () => {
    const compiled = buildQuery(
      input({
        source: 'events',
        measures: [measure('conversions')],
        dimensions: ['day'],
        conversionNames: ['Order Completed', 'Signed Up'],
      }),
    );
    expect(compiled.sql).toContain('FROM events FINAL');
    expect(compiled.sql).toContain("timestamp >= {from:DateTime64(3, 'UTC')}");
    expect(compiled.sql).toContain('name IN {names:Array(String)}');
    expect(compiled.sql).toContain('uniqExact(event_id) AS base_conversions');
    expect(compiled.sql).toContain("uniqExact(if(anonymous_id != '', anonymous_id,");
    expect(compiled.params.names).toEqual(['Order Completed', 'Signed Up']);
    expect(compiled.params.types).toBeUndefined();
  });

  it('groups revenue by currency and keeps the conversion map in parameters', () => {
    const rules: ConversionRule[] = [
      { event: 'Order Completed', value: 'order.total', currencyProperty: 'order.currency' },
      { event: 'Signed Up', value: 'plan.value', currency: 'DKK' },
    ];
    const compiled = buildQuery(input({ source: 'events', measures: [measure('revenue')], conversionRules: rules }));

    expect(compiled.revenue).toBe(true);
    expect(compiled.sql).toContain('AS dim_currency');
    expect(compiled.sql).toContain('GROUP BY multiIf(name = {conv0:String}');
    expect(compiled.sql).toContain('base_revenue AS measure_revenue');
    expect(compiled.columns).toEqual([
      { name: 'currency', kind: 'dimension' },
      { name: 'revenue', kind: 'measure', unit: 'currency' },
    ]);
    expect(compiled.outputs[0]).toEqual({ kind: 'dimension', dimension: 'currency', alias: 'dim_currency' });
    expect(compiled.params).toMatchObject({
      conv0: 'Order Completed',
      conv0_key0: 'order',
      conv0_key1: 'total',
      conv0_cur0: 'order',
      conv0_cur1: 'currency',
      conv1: 'Signed Up',
      conv1_key0: 'plan',
      conv1_key1: 'value',
      conv1_currency: 'DKK',
    });
  });

  it('refuses a ratio that names a base measure the registry does not have', () => {
    expect(() => buildQuery(input({ measures: [ratio({ numerator: 'nope' })] }))).toThrow('ratio fake.rate refers to missing base nope');
    expect(() => buildQuery(input({ measures: [ratio({ numerator: 'email.click_rate' })] }))).toThrow(
      'ratio fake.rate refers to missing base email.click_rate',
    );
  });

  it('refuses measures whose storage is not the ClickHouse event tables', () => {
    expect(() => buildQuery(input({ measures: [measure('segment.members')], source: 'segment_memberships' }))).toThrow(
      'segment membership is read from Postgres, not ClickHouse',
    );
    expect(() => buildQuery(input({ measures: [measure('campaign.recipients')], source: 'campaign' }))).toThrow(
      'campaign.recipients is compiled by the campaign query builder',
    );
  });

  it('names the dimensions a rejected breakdown would accept', () => {
    expect(invalidDimensionMessage(measure('email.sent'), 'segment')).toBe(
      'email.sent cannot be broken down by "segment". It supports: day, week, month, channel, template, broadcast, journey, purpose, variant, message_type, campaign.',
    );
  });
});

describe('revenue expressions', () => {
  it('produces zero and UNKNOWN without a conversion map', () => {
    const params: Record<string, unknown> = {};
    const expressions = revenueExpressions([], params);
    expect(expressions).toEqual({ value: 'toFloat64(0)', currency: "'UNKNOWN'" });
    expect(params).toEqual({});
  });

  it('uses the first rule per event so a conversion is never counted twice', () => {
    const params: Record<string, unknown> = {};
    const expressions = revenueExpressions(
      [
        { event: 'Order Completed', value: 'total', currency: 'DKK' },
        { event: 'Order Completed', value: 'ignored', currency: 'EUR' },
      ],
      params,
    );
    expect(expressions.value).toBe(
      'multiIf(name = {conv0:String}, JSONExtractFloat(toString(properties), {conv0_key0:String}), toFloat64(0))',
    );
    expect(expressions.currency).toBe("multiIf(name = {conv0:String}, {conv0_currency:String}, 'UNKNOWN')");
    expect(params).toEqual({ conv0: 'Order Completed', conv0_key0: 'total', conv0_currency: 'DKK' });
  });

  it('reads a nested currency property and falls back to UNKNOWN when it is empty', () => {
    const params: Record<string, unknown> = {};
    const expressions = revenueExpressions([{ event: 'Order Completed', currencyProperty: 'order.currency' }], params);
    expect(expressions.value).toBe('multiIf(name = {conv0:String}, toFloat64(0), toFloat64(0))');
    expect(expressions.currency).toContain(
      "if(upper(JSONExtractString(toString(properties), {conv0_cur0:String}, {conv0_cur1:String})) = '', 'UNKNOWN',",
    );
    expect(params).toMatchObject({ conv0_cur0: 'order', conv0_cur1: 'currency' });
  });
});

describe('dimension expressions', () => {
  it('uses the event-time column that the source actually has', () => {
    expect(dimensionExpression('message_events', 'day')).toContain('toStartOfDay(at, {tz:String})');
    expect(dimensionExpression('journey_events', 'week')).toContain('toStartOfWeek(at, 1, {tz:String})');
    expect(dimensionExpression('events', 'month')).toContain('toStartOfMonth(timestamp, {tz:String})');
  });

  it('maps labels, journey steps and segments to their columns', () => {
    expect(dimensionExpression('message_events', 'broadcast')).toContain("startsWith(journey_id, 'bct_')");
    expect(dimensionExpression('message_events', 'message_type')).toContain("multiIf(startsWith(journey_id, 'bct_'), 'broadcast'");
    expect(dimensionExpression('journey_events', 'journey_step')).toBe('node');
    expect(dimensionExpression('segment_memberships', 'segment')).toBe('segment_id');
  });

  it('returns an empty expression for a combination the source cannot express', () => {
    // The public entry point (query.ts) rejects these before compiling; this pins the compiler's
    // own fallback so it cannot silently invent a column.
    expect(dimensionExpression('events', 'channel')).toBe('');
    expect(dimensionExpression('message_events', 'segment')).toBe('');
  });
});
