import { describe, expect, it } from 'vitest';
import { buildCampaignQuery, type CampaignBuildInput, type CampaignQueryMap, type CampaignRecord, goalEventsFor } from '../src/campaign';
import { MEASURES, type MeasureDef } from '../src/registry';

const CAMPAIGN = `cmp_${'a'.repeat(32)}`;
const OTHER_CAMPAIGN = `cmp_${'b'.repeat(32)}`;
const THIRD_CAMPAIGN = `cmp_${'e'.repeat(32)}`;
const BROADCAST = `bct_${'c'.repeat(32)}`;
const OTHER_BROADCAST = `bct_${'f'.repeat(32)}`;
const THIRD_BROADCAST = `bct_${'g'.repeat(32)}`;
const JOURNEY = `jrn_${'d'.repeat(32)}`;

const goal = { kind: 'conversion' as const, event: 'Order Completed', target: null, attributionDays: 7 };

const record = (overrides: Partial<CampaignRecord> = {}): CampaignRecord => ({
  id: CAMPAIGN,
  name: 'Autumn launch',
  version: 3,
  published: true,
  goal,
  utmCampaign: 'autumn-launch',
  startsAt: null,
  members: [
    { artifactId: BROADCAST, name: 'Newsletter', type: 'broadcast', role: 'primary', published: true },
    { artifactId: JOURNEY, name: 'Welcome', type: 'journey', role: 'follow_up', published: true },
  ],
  ...overrides,
});

const queryMap = (overrides: Partial<CampaignQueryMap> = {}): CampaignQueryMap => ({
  map: { memberIds: [BROADCAST, JOURNEY], memberCampaignIds: [CAMPAIGN, CAMPAIGN] },
  scopes: [{ id: CAMPAIGN, name: 'Autumn launch', goal, memberIds: [BROADCAST, JOURNEY], goalEvents: ['Order Completed'] }],
  records: [record()],
  ...overrides,
});

const measure = (id: string): MeasureDef => {
  const found = MEASURES[id];
  if (!found) throw new Error(`no measure ${id}`);
  return found;
};

const input = (overrides: Partial<CampaignBuildInput> = {}): CampaignBuildInput => ({
  workspaceId: 'ws_01',
  measures: [measure('campaign.recipients'), measure('campaign.converters'), measure('campaign.conversion_rate')],
  dimensions: ['campaign'],
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-31T00:00:00.000Z',
  timeZone: 'Europe/Copenhagen',
  filters: {},
  limit: 50,
  conversionRules: [],
  queryMap: queryMap(),
  ...overrides,
});

describe('campaign goal events', () => {
  it('follows the campaign event for a non-revenue goal', () => {
    expect(goalEventsFor(goal, ['Order Completed', 'Signed Up'])).toEqual(['Order Completed']);
    expect(goalEventsFor({ ...goal, kind: 'signups', event: 'Signed Up' }, [])).toEqual(['Signed Up']);
    expect(goalEventsFor({ ...goal, kind: 'signups', event: null }, [])).toEqual([]);
  });

  it('follows the conversion map for a revenue goal, keeping the campaign event too', () => {
    const revenue = { ...goal, kind: 'revenue' as const };
    expect(goalEventsFor(revenue, ['Order Completed', 'Subscription Started'])).toEqual(['Order Completed', 'Subscription Started']);
    expect(goalEventsFor(revenue, ['Order Completed', 'Order Completed'])).toEqual(['Order Completed']);
    expect(goalEventsFor(revenue, [])).toEqual(['Order Completed']);
    expect(goalEventsFor({ ...revenue, event: null }, ['Order Completed'])).toEqual(['Order Completed']);
  });
});

describe('campaign query compiler', () => {
  it('compiles recipients, converters and the conversion rate into the shared result shape', () => {
    const compiled = buildCampaignQuery(input());

    expect(compiled.sql).toContain('WITH identity AS');
    expect(compiled.sql).toContain('recipient AS');
    expect(compiled.sql).toContain('goal_map AS');
    expect(compiled.sql).toContain('conversion AS');
    expect(compiled.sql).toContain('rec_roll AS');
    expect(compiled.sql).toContain('conv_roll AS');
    expect(compiled.sql).toContain('FROM message_events m FINAL');
    expect(compiled.sql).toContain("type IN ('sent', 'delivered')");
    expect(compiled.sql).toContain('arrayElement({campaign_map_ids:Array(String)}');
    expect(compiled.sql).toContain('FROM events e FINAL');
    expect(compiled.sql).toContain('campaign_attr_days:Array(Int32)');
    expect(compiled.sql).toContain('campaign_id AS dim_campaign');
    expect(compiled.sql).toContain('ORDER BY r.dim_campaign ASC');
    expect(compiled.sql).toContain('LIMIT {limit:UInt32}');
    expect(compiled.sql).toContain(
      'if(r.base_campaign_recipients = 0, NULL, ifNull(c.base_campaign_converters, 0) / r.base_campaign_recipients) AS measure_campaign_conversion_rate',
    );

    expect(compiled.params).toMatchObject({
      ws: 'ws_01',
      tz: 'Europe/Copenhagen',
      from: '2026-10-01T00:00:00.000',
      to: '2026-10-31T00:00:00.000',
      limit: 50,
      campaign_map_members: [BROADCAST, JOURNEY],
      campaign_map_ids: [CAMPAIGN, CAMPAIGN],
      campaign_attr_days: [7],
      goal_events: ['Order Completed'],
      goal_event_campaigns: [CAMPAIGN],
      goal_pair_count: 1,
    });
    expect(compiled.columns).toEqual([
      { name: 'campaign', kind: 'dimension' },
      { name: 'campaign.recipients', kind: 'measure', unit: 'count' },
      { name: 'campaign.converters', kind: 'measure', unit: 'count' },
      { name: 'campaign.conversion_rate', kind: 'measure', unit: 'ratio' },
    ]);
    expect(compiled.outputs).toEqual([
      { kind: 'dimension', dimension: 'campaign', alias: 'dim_campaign' },
      { kind: 'measure', measure: MEASURES['campaign.recipients'], alias: 'measure_campaign_recipients' },
      { kind: 'measure', measure: MEASURES['campaign.converters'], alias: 'measure_campaign_converters' },
      {
        kind: 'measure',
        measure: MEASURES['campaign.conversion_rate'],
        alias: 'measure_campaign_conversion_rate',
        numeratorAlias: 'measure_campaign_converters',
        denominatorAlias: 'measure_campaign_recipients',
      },
    ]);
    expect(compiled.kAlias).toBe('k_group');
    expect(compiled.revenueKAlias).toBeUndefined();
    expect(compiled.hasNonTimeDimension).toBe(true);
    expect(compiled.revenue).toBe(false);
  });

  it('keeps totals free of a breakdown and orders them by the first measure', () => {
    const compiled = buildCampaignQuery(input({ dimensions: [] }));
    expect(compiled.sql).not.toContain('GROUP BY r.');
    expect(compiled.sql).toContain('ON 1 = 1');
    expect(compiled.sql).toContain('ORDER BY measure_campaign_recipients DESC');
    expect(compiled.hasNonTimeDimension).toBe(false);
  });

  it('uses the send time for day, week and month breakdowns', () => {
    const day = buildCampaignQuery(input({ dimensions: ['day'] }));
    expect(day.sql).toContain('send_day AS dim_day');
    expect(day.sql).toContain('GROUP BY dim_day');
    expect(day.hasNonTimeDimension).toBe(false);

    const week = buildCampaignQuery(input({ dimensions: ['week'], order: { by: 'week', dir: 'desc' } }));
    expect(week.sql).toContain('send_week AS dim_week');
    expect(week.sql).toContain('ORDER BY r.dim_week DESC');
  });

  it('joins revenue and groups it by currency', () => {
    const compiled = buildCampaignQuery(
      input({
        measures: [measure('campaign.revenue'), measure('campaign.revenue_per_recipient')],
        conversionRules: [{ event: 'Order Completed', value: 'order.total', currency: 'DKK' }],
      }),
    );

    expect(compiled.revenue).toBe(true);
    expect(compiled.kAlias).toBe('k_group');
    expect(compiled.revenueKAlias).toBe('k_revenue_group');
    // The k-group is the converters in that currency (rev_roll), not the campaign's converters
    // overall: after #779 conv_roll is no longer split by currency (#756 with #779).
    expect(compiled.sql).toContain('uniqExact(profile_id) AS base_currency_converters');
    expect(compiled.sql).toContain('ifNull(rv.base_currency_converters, 0) AS k_revenue_group');
    expect(compiled.sql).not.toContain('ifNull(c.base_campaign_converters, 0) AS k_revenue_group');
    expect(compiled.sql).toContain('LEFT JOIN conv_roll');
    expect(compiled.sql).toContain('LEFT JOIN rev_roll rv');
    expect(compiled.sql).toContain('currency AS dim_currency');
    expect(compiled.sql).toContain('sum(revenue_value) AS base_campaign_revenue');
    expect(compiled.sql).toContain('rv.dim_currency');
    expect(compiled.sql).toContain('ifNull(rv.base_campaign_revenue, 0) AS base_campaign_revenue');
    expect(compiled.sql).toContain(
      'if(r.base_campaign_recipients = 0, NULL, ifNull(rv.base_campaign_revenue, 0) / r.base_campaign_recipients) AS measure_campaign_revenue_per_recipient',
    );
    // #779: currency partitions revenue only. The converter roll stays a single total per
    // campaign group, so converters and the rate do not change when revenue is co-requested.
    const converterRoll = compiled.sql.slice(compiled.sql.indexOf('conv_roll AS'), compiled.sql.indexOf('rev_roll AS'));
    expect(converterRoll).toContain('uniqExact(profile_id) AS base_campaign_converters');
    expect(converterRoll).not.toContain('currency');
    expect(compiled.columns).toEqual([
      { name: 'campaign', kind: 'dimension' },
      { name: 'currency', kind: 'dimension' },
      { name: 'campaign.revenue', kind: 'measure', unit: 'currency' },
      { name: 'campaign.revenue_per_recipient', kind: 'measure', unit: 'currency' },
    ]);
    expect(compiled.outputs[0]).toEqual({ kind: 'dimension', dimension: 'campaign', alias: 'dim_campaign' });
    expect(compiled.outputs[1]).toEqual({ kind: 'dimension', dimension: 'currency', alias: 'dim_currency' });
    expect(compiled.params).toMatchObject({ conv0: 'Order Completed' });
    expect(compiled.params.conv0_key0).toBe('order');
    expect(compiled.params.conv0_currency).toBe('DKK');
  });

  it('pairs every campaign goal event with its campaign in the parameter arrays', () => {
    const compiled = buildCampaignQuery(
      input({
        queryMap: queryMap({
          scopes: [
            { id: CAMPAIGN, name: 'One', goal, memberIds: [BROADCAST], goalEvents: ['Order Completed', 'Signed Up'] },
            {
              id: OTHER_CAMPAIGN,
              name: 'Two',
              goal: { ...goal, kind: 'revenue' },
              memberIds: [JOURNEY],
              goalEvents: ['Order Completed'],
            },
          ],
        }),
      }),
    );
    expect(compiled.params.goal_events).toEqual(['Order Completed', 'Signed Up', 'Order Completed']);
    expect(compiled.params.goal_event_campaigns).toEqual([CAMPAIGN, CAMPAIGN, OTHER_CAMPAIGN]);
    expect(compiled.params.goal_pair_count).toBe(3);
    expect(compiled.params.campaign_window_ids).toEqual([CAMPAIGN, OTHER_CAMPAIGN]);
    expect(compiled.params.campaign_attr_days).toEqual([7, 7]);
  });

  it('gives every campaign its own attribution window when a campaign has several sending members (#629)', () => {
    const compiled = buildCampaignQuery(
      input({
        queryMap: queryMap({
          // The member arrays are member-aligned: the first campaign has two sending members.
          map: {
            memberIds: [BROADCAST, JOURNEY, OTHER_BROADCAST, THIRD_BROADCAST],
            memberCampaignIds: [CAMPAIGN, CAMPAIGN, OTHER_CAMPAIGN, THIRD_CAMPAIGN],
          },
          scopes: [
            { id: CAMPAIGN, name: 'One', goal, memberIds: [BROADCAST, JOURNEY], goalEvents: ['Order Completed'] },
            {
              id: OTHER_CAMPAIGN,
              name: 'Two',
              goal: { ...goal, attributionDays: 30 },
              memberIds: [OTHER_BROADCAST],
              goalEvents: ['Order Completed'],
            },
            {
              id: THIRD_CAMPAIGN,
              name: 'Three',
              goal: { ...goal, attributionDays: 1 },
              memberIds: [THIRD_BROADCAST],
              goalEvents: ['Order Completed'],
            },
          ],
        }),
      }),
    );

    // The campaign map stays member-aligned; the window pair is one entry per campaign.
    expect(compiled.params.campaign_map_ids).toEqual([CAMPAIGN, CAMPAIGN, OTHER_CAMPAIGN, THIRD_CAMPAIGN]);
    expect(compiled.params.campaign_window_ids).toEqual([CAMPAIGN, OTHER_CAMPAIGN, THIRD_CAMPAIGN]);
    expect(compiled.params.campaign_attr_days).toEqual([7, 30, 1]);
    expect(compiled.sql).toContain(
      'arrayElement({campaign_attr_days:Array(Int32)}, indexOf({campaign_window_ids:Array(String)}, r.campaign_id))',
    );
    // The misaligned lookup is gone: a member-aligned index must never pick a window.
    expect(compiled.sql).not.toContain('indexOf({campaign_map_ids:Array(String)}, r.campaign_id)');
  });

  it('deduplicates the campaign window pair by campaign id (#629)', () => {
    const compiled = buildCampaignQuery(
      input({
        queryMap: queryMap({
          scopes: [
            { id: CAMPAIGN, name: 'One', goal, memberIds: [BROADCAST], goalEvents: ['Order Completed'] },
            {
              id: CAMPAIGN,
              name: 'One again',
              goal: { ...goal, attributionDays: 30 },
              memberIds: [JOURNEY],
              goalEvents: ['Order Completed'],
            },
          ],
        }),
      }),
    );
    expect(compiled.params.campaign_window_ids).toEqual([CAMPAIGN]);
    expect(compiled.params.campaign_attr_days).toEqual([7]);
  });

  it('keeps a campaign with recipients and no conversions in the revenue roll-up (#630)', () => {
    const compiled = buildCampaignQuery(
      input({
        measures: [measure('campaign.recipients'), measure('campaign.revenue'), measure('campaign.revenue_per_recipient')],
        conversionRules: [{ event: 'Order Completed', value: 'order.total', currency: 'DKK' }],
      }),
    );

    // conv_roll only holds converting groups, so the join must keep every recipient group.
    expect(compiled.sql).toContain('LEFT JOIN conv_roll');
    expect(compiled.sql).not.toContain('INNER JOIN conv_roll');
    expect(compiled.sql).toContain('ifNull(rv.base_campaign_revenue, 0) AS base_campaign_revenue');
    expect(compiled.sql).toContain('ifNull(rv.base_campaign_revenue, 0) AS measure_campaign_revenue');
    expect(compiled.sql).toContain(
      'if(r.base_campaign_recipients = 0, NULL, ifNull(rv.base_campaign_revenue, 0) / r.base_campaign_recipients)',
    );
  });

  it('attributes conversions through the shared identity map (#590)', () => {
    const compiled = buildCampaignQuery(
      input({
        identity: {
          pairs: [
            { key: 'anon-before-merge', profileId: CAMPAIGN, kind: 'anonymous_id' },
            { key: 'previous-profile', profileId: CAMPAIGN, kind: 'profile' },
            { key: 'user-before-merge', profileId: CAMPAIGN, kind: 'user_id' },
          ],
          overLimit: false,
          limit: 2000,
        },
      }),
    );

    expect(compiled.params.identity_keys_0).toEqual(['anon-before-merge', 'previous-profile', 'user-before-merge']);
    expect(compiled.params.identity_profiles_0).toEqual([CAMPAIGN, CAMPAIGN, CAMPAIGN]);
    expect(compiled.params.identity_kinds_0).toEqual(['anonymous_id', 'profile', 'user_id']);
    expect(compiled.params.identity_count).toBe(3);
    expect(compiled.sql).toContain('event_identity AS');
    // The recipient resolves through the same map as the conversion, so a send stored under a
    // merged-away profile matches an event stored under the survivor (#590).
    expect(compiled.sql).toContain(
      "LEFT JOIN identity by_profile ON by_profile.identity_key = m.profile_id AND by_profile.kind = 'profile'",
    );
    expect(compiled.sql.indexOf('identity AS')).toBeLessThan(compiled.sql.indexOf('recipient AS'));
    expect(compiled.sql).toContain("LEFT JOIN identity by_user ON by_user.identity_key = e.user_id AND by_user.kind = 'user_id'");
    expect(compiled.sql).toContain(
      "LEFT JOIN identity by_anonymous ON by_anonymous.identity_key = e.anonymous_id AND by_anonymous.kind = 'anonymous_id'",
    );
    expect(compiled.sql).toContain(
      "LEFT JOIN identity by_profile ON by_profile.identity_key = e.profile_id AND by_profile.kind = 'profile'",
    );
    expect(compiled.sql).toContain('INNER JOIN recipient r ON r.profile_id = i.profile_id');
  });

  it('does not ship an identity map above its bound (#590)', () => {
    const compiled = buildCampaignQuery(
      input({
        identity: {
          pairs: [{ key: 'anon-before-merge', profileId: CAMPAIGN, kind: 'anonymous_id' }],
          overLimit: true,
          limit: 2000,
        },
      }),
    );
    expect(compiled.params.identity_count).toBe(0);
    expect(compiled.params.identity_keys_0).toEqual([]);
    expect(compiled.params.identity_profiles_0).toEqual([]);
    expect(compiled.params.identity_kinds_0).toEqual([]);
    // The SQL is still valid: it falls back to the stored profile id, which the caller reports.
    expect(compiled.sql).toContain('event_identity AS');
  });

  it('splits a campaign-sized identity map across form fields (#590)', () => {
    // 5,000 pairs of 36-character keys are ~190 KiB per array, above ClickHouse's 128 KiB field
    // limit. The map must become several fields that arrayConcat restores in order.
    const pairs = Array.from({ length: 5_000 }, (_, i) => ({
      key: `anon_${i.toString().padStart(31, '0')}`,
      profileId: `prf_${i.toString().padStart(32, '0')}`,
      kind: 'anonymous_id' as const,
    }));
    const compiled = buildCampaignQuery(input({ identity: { pairs, overLimit: false, limit: 100_000 } }));
    expect(compiled.params.identity_count).toBe(5_000);
    expect(compiled.params.identity_keys_1).toBeDefined();
    expect(compiled.sql).toContain('arrayConcat(');
    const first = compiled.params.identity_keys_0 as string[];
    const second = compiled.params.identity_keys_1 as string[];
    expect(first.length + second.length).toBe(5_000);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(120 * 1024);
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(120 * 1024);
  });

  it('refuses a measure that is not a campaign measure', () => {
    expect(() => buildCampaignQuery(input({ measures: [measure('email.sent')] }))).toThrow('email.sent is not a campaign measure');
  });

  it('selects the base aliases its ratio output names (#209)', () => {
    // The campaign compiler now selects every base a ratio names, as the generic compiler does, so an Output's numeratorAlias/denominatorAlias is always a column in the SQL.
    const compiled = buildCampaignQuery(input({ measures: [measure('campaign.conversion_rate')] }));
    expect(compiled.sql).toContain('AS measure_campaign_converters');
    expect(compiled.sql).toContain('AS measure_campaign_recipients');
  });

  it('selects the base aliases revenue_per_recipient alone names', () => {
    const compiled = buildCampaignQuery(
      input({
        measures: [measure('campaign.revenue_per_recipient')],
        conversionRules: [{ event: 'Order Completed', value: 'order.total', currency: 'DKK' }],
      }),
    );
    expect(compiled.sql).toContain('AS measure_campaign_revenue');
    expect(compiled.sql).toContain('AS measure_campaign_recipients');
    expect(compiled.outputs.at(-1)).toEqual({
      kind: 'measure',
      measure: MEASURES['campaign.revenue_per_recipient'],
      alias: 'measure_campaign_revenue_per_recipient',
      numeratorAlias: 'measure_campaign_revenue',
      denominatorAlias: 'measure_campaign_recipients',
    });
  });
});
