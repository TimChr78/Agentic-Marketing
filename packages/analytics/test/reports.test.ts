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
      topology: null,
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
      topology: null,
    });
    expect(result.totals).toEqual({ entered: 100, goalReached: 60, completed: 50, exited: 10 });
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60]);
    expect(result.withheld).toEqual([]);
    expect(result.complementary).toBe(false);
  });

  it('hides the smallest visible step when exactly one step row is hidden (no topology)', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: [
        { step: 'a', reached: 100 },
        { step: 'b', reached: null },
        { step: 'c', reached: 40 },
        { step: 'd', reached: 60 },
      ],
      topology: null,
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
      topology: null,
    });
    expect(result.steps.map((step) => step.reached)).toEqual([null, null, 100]);
    expect(result.complementary).toBe(false);
    expect(result.withheld).toEqual([]);
  });
});

// #917 review round 2: a hidden branch can be recovered from its parent or merge, so the complement
// must be a sibling in the same relation — never an unrelated step.
describe('journey funnel suppression follows the published topology (#908 review)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });
  const node = (id: string, kind: string, children: string[] = []) => ({ id, kind, children });
  const steps = (values: Record<string, number | null>) => Object.entries(values).map(([step, reached]) => ({ step, reached }));
  /** Every arithmetic difference between visible numbers in the response. */
  const differences = (result: ReturnType<typeof plan>): number[] => {
    const visible = [
      ...result.steps.flatMap((step) => (step.reached === null ? [] : [step.reached])),
      ...Object.values(result.totals).flatMap((value) => (value === null ? [] : [value])),
    ];
    const out: number[] = [];
    for (const a of visible) for (const b of visible) if (a !== b) out.push(Math.abs(a - b));
    return out;
  };
  /** The count a relation with exactly one hidden term would hand back. */
  const derivable = (values: (number | null)[]): number | null => {
    const hidden = values.filter((value) => value === null).length;
    if (hidden !== 1) return null;
    const total = values[0]!;
    return total - values.slice(1).reduce((sum: number, value) => sum + (value ?? 0), 0);
  };

  it('protects the branch Sol reported: 100 fork, A 97, A downstream 5, B 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, a_down: 5, b: null }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['a_down']), node('a_down', 'wait'), node('b', 'wait')],
    });
    // B was hidden; A is the only visible sibling, so hiding an unrelated downstream step is not
    // enough. A is hidden with it, and no arithmetic on the visible numbers gives 3.
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, 5, null]);
    expect(derivable([100, result.steps[1]!.reached, result.steps[3]!.reached])).toBeNull();
    expect(differences(result)).not.toContain(3);
    expect(result.complementary).toBe(true);
  });

  it('hides the smallest visible sibling in a two-way fork 97/3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, b: null }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait'), node('b', 'wait')],
    });
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, null]);
    expect(differences(result)).not.toContain(3);
  });

  it('hides the smallest visible sibling in a three-way fork with one hidden branch', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 60, b: 30, c: null }),
      topology: [node('start', 'trigger', ['a', 'b', 'c']), node('a', 'wait'), node('b', 'wait'), node('c', 'wait')],
    });
    // b (30) is the smallest visible sibling of the hidden c (4); a stays visible.
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60, null, null]);
    expect(differences(result)).not.toContain(4);
  });

  it('leaves a linear chain alone but nulls drop-offs around the hidden step', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, s1: 60, s2: null, s3: 55 }),
      topology: [node('start', 'trigger', ['s1']), node('s1', 'wait', ['s2']), node('s2', 'wait', ['s3']), node('s3', 'wait')],
    });
    // A single hidden step on a line has no sibling to hide; the handler nulls the drop-offs.
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60, null, 55]);
    expect(result.complementary).toBe(false);
    expect(result.withheld).toEqual([]);
  });

  it('hides nothing more when two siblings are already hidden', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: null, b: null }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait'), node('b', 'wait')],
    });
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, null]);
    expect(result.complementary).toBe(false);
  });

  it('protects a reconvergence: join 100, arm A 97, arm B 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, b: null, join: 100 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['join']), node('b', 'wait', ['join']), node('join', 'wait')],
    });
    // The fork a/b has one hidden term, so its smallest visible sibling is hidden. The merge into
    // join then has two hidden terms, so the visible join is not a way back to 3.
    expect(result.steps.find((step) => step.step === 'a')?.reached).toBeNull();
    expect(result.steps.find((step) => step.step === 'join')?.reached).toBe(100);
    expect(differences(result)).not.toContain(3);
  });

  it('withholds a visible headline goalReached when its goal step row is hidden', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 50, completed: 0, exited: 0 },
      steps: steps({ start: 100, goal: null }),
      topology: [node('start', 'trigger', ['goal']), node('goal', 'goal', ['done']), node('done', 'exit')],
    });
    expect(result.totals.goalReached).toBeNull();
    expect(result.withheld).toEqual(['goalReached']);
  });

  it('returns zero rows unchanged', () => {
    const result = plan({
      totals: { entered: 0, goalReached: 0, completed: 0, exited: 0 },
      steps: [],
      topology: [node('start', 'trigger', ['a']), node('a', 'wait')],
    });
    expect(result.totals).toEqual({ entered: 0, goalReached: 0, completed: 0, exited: 0 });
    expect(result.steps).toEqual([]);
    expect(result.withheld).toEqual([]);
  });
});
