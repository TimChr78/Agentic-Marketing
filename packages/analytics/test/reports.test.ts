import { describe, expect, it } from 'vitest';
import { analyticsCampaignSummary } from '../src/campaignSummary';
import { analyticsReports } from '../src/reports';

const CAMPAIGN = `cmp_${'a'.repeat(32)}`;

describe('named reports', () => {
  it('registers each report once, as a read of the artefact catalogue', () => {
    expect(analyticsReports.map((r) => r.name)).toEqual(['analytics.emailPerformance', 'analytics.journeyFunnel']);
    expect(new Set(analyticsReports.map((r) => r.name)).size).toBe(analyticsReports.length);
    for (const report of analyticsReports) {
      expect(report.permission).toBe('artifacts:read');
      expect(report.effect).toBe('read');
    }
  });

  it('defaults e-mail performance to a daily breakdown and rejects other groupings', () => {
    const base = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };
    expect(analyticsReports[0]!.input.parse(base)).toMatchObject({ by: 'day' });
    for (const by of ['template', 'broadcast', 'journey']) expect(analyticsReports[0]!.input.safeParse({ ...base, by }).success).toBe(true);
    expect(analyticsReports[0]!.input.safeParse({ ...base, by: 'segment' }).success).toBe(false);
  });

  it('requires a journey id for the funnel and a campaign id for the summary', () => {
    const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };
    const funnel = analyticsReports[1]!.input;
    expect(funnel.safeParse({ ...range, journeyId: `jrn_${'b'.repeat(32)}` }).success).toBe(true);
    expect(funnel.safeParse({ ...range, journeyId: CAMPAIGN }).success).toBe(false);

    expect(analyticsCampaignSummary.input.safeParse({ campaignId: CAMPAIGN }).success).toBe(true);
    expect(analyticsCampaignSummary.input.safeParse({ campaignId: 'cmp_1' }).success).toBe(false);
    expect(analyticsCampaignSummary.input.safeParse({ campaignId: CAMPAIGN, from: 'soon' }).success).toBe(false);
  });

  it('makes the date range optional for the campaign summary but required for the funnel', () => {
    expect(analyticsCampaignSummary.input.safeParse({ campaignId: CAMPAIGN }).success).toBe(true);
    expect(analyticsReports[1]!.input.safeParse({ journeyId: `jrn_${'b'.repeat(32)}` }).success).toBe(false);
  });
});
