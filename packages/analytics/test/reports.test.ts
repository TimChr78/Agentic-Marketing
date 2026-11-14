import { describe, expect, it } from 'vitest';
import { analyticsCampaignSummary } from '../src/campaignSummary';
import { analyticsReports, planJourneyFunnelSuppression } from '../src/reports';

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

// #908: the funnel's headline totals are a `dimensions: []` query and used to be printed raw beside
// k-suppressed step rows. They now go through the same rule as every other total: a positive count
// below k is withheld, exactly one hidden step brings the smallest visible step with it, and a total
// that is a hidden step's count (`entered` and the entry step) is withheld.
describe('journey funnel totals follow the k floor (#908)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });

  it('withholds every positive total below k', () => {
    const result = plan({
      totals: { entered: 3, goalReached: 2, completed: 0, exited: 4 },
      steps: [
        { step: 'trigger', reached: null },
        { step: 'goal', reached: null },
      ],
    });
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: 0, exited: null });
    expect(result.withheld).toEqual(['entered', 'goalReached', 'exited']);
    expect(result.steps.map((step) => step.reached)).toEqual([null, null]);
  });

  it('leaves a funnel with visible steps and totals at or above k untouched', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: [
        { step: 'a', reached: 100 },
        { step: 'b', reached: 60 },
      ],
    });
    expect(result.totals).toEqual({ entered: 100, goalReached: 60, completed: 50, exited: 10 });
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60]);
    expect(result.withheld).toEqual([]);
    expect(result.complementary).toBe(false);
  });

  it('hides the smallest visible step when exactly one step row is hidden', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: [
        { step: 'a', reached: 100 },
        { step: 'b', reached: null },
        { step: 'c', reached: 40 },
        { step: 'd', reached: 60 },
      ],
    });
    // c is the smallest visible contributor with a value; only a sum of hidden values is derivable.
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, null, 60]);
    expect(result.complementary).toBe(true);
    expect(result.totals.entered).toBe(100);
  });

  it('hides every visible step when two are already hidden, and keeps the visible total', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: [
        { step: 'a', reached: null },
        { step: 'b', reached: null },
        { step: 'c', reached: 100 },
      ],
    });
    expect(result.steps.map((step) => step.reached)).toEqual([null, null, 100]);
    expect(result.complementary).toBe(false);
    expect(result.withheld).toEqual([]);
  });
});
