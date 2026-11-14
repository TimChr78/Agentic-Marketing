import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test-support/index';
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

// #917 review round 3: a headline that sums steps must be in the same relation set, or a hidden
// term leaks through it. A graph with two exits made `completed = 100` and one exit's reach visible
// beside the other hidden exit. The same class is caught here for random small topologies: the test
// runs a solver over every published additive relation (and chains of them) and fails if any hidden
// count below k becomes derivable.
describe('journey funnel suppression cannot be bypassed by a headline (#908 review round 3)', () => {
  type Node = { id: string; kind: string; children: string[] };
  type Graph = { nodes: Node[]; counts: Map<string, number>; goal?: string; terminal: string[] };

  const makeGraph = (random: () => number): Graph => {
    const int = (max: number) => Math.floor(random() * max);
    const nodes: Node[] = [{ id: 'n0', kind: 'trigger', children: [] }];
    const counts = new Map<string, number>([['n0', 60 + int(140)]]);
    const leaves = ['n0'];
    const split = (total: number, parts: number): number[] => {
      const out = Array.from({ length: parts }, () => 1);
      let left = total - parts;
      while (left > 0) {
        out[int(parts)]! += 1;
        left -= 1;
      }
      return out;
    };
    let next = 1;
    const add = (kind = 'wait') => {
      const id = `n${next++}`;
      nodes.push({ id, kind, children: [] });
      return id;
    };
    for (let step = 0; step < 7 + int(6); step++) {
      const roll = random();
      if (roll < 0.4 && leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const total = counts.get(parent)!;
        const parts = total >= 3 ? 2 + int(2) : 1;
        const shares = split(total, parts);
        const children = shares.map((share) => {
          const id = add();
          nodes.find((node) => node.id === parent)!.children.push(id);
          counts.set(id, share);
          return id;
        });
        leaves.splice(leaves.indexOf(parent), 1, ...children);
      } else if (roll < 0.65 && leaves.length >= 2) {
        // A merge whose parents each feed only it, so `node = sum(parents)` stays exact.
        const first = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(first), 1);
        const second = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(second), 1);
        const id = add();
        for (const parent of [first, second]) {
          nodes.find((node) => node.id === parent)!.children.push(id);
          counts.set(parent, counts.get(parent)!);
        }
        counts.set(id, counts.get(first)! + counts.get(second)!);
        leaves.push(id);
      } else if (leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const id = add();
        nodes.find((node) => node.id === parent)!.children.push(id);
        counts.set(id, counts.get(parent)!);
        leaves.splice(leaves.indexOf(parent), 1, id);
      }
    }
    for (const leaf of leaves) {
      if (random() < 0.5) {
        nodes.find((node) => node.id === leaf)!.kind = 'goal';
        break;
      }
    }
    const goal = nodes.find((node) => node.kind === 'goal')?.id;
    return { nodes, counts, ...(goal ? { goal } : {}), terminal: leaves };
  };

  /** Relations the response publishes: forks, merges and the headline sums. */
  const relationsOf = (graph: Graph): { name: string; terms: (string | null)[] }[] => {
    const value = (id: string) => graph.counts.get(id) ?? 0;
    const out: { name: string; terms: (string | null)[] }[] = [];
    for (const node of graph.nodes) {
      if (node.children.length >= 2) out.push({ name: `fork:${node.id}`, terms: [node.id, ...node.children] });
      const parents = graph.nodes.filter((parent) => parent.children.includes(node.id));
      if (parents.length >= 2) out.push({ name: `merge:${node.id}`, terms: [node.id, ...parents.map((parent) => parent.id)] });
    }
    out.push({
      name: 'headline:entered',
      terms: ['entered', ...graph.nodes.filter((node) => node.kind === 'trigger').map((node) => node.id)],
    });
    if (graph.goal) out.push({ name: 'headline:goalReached', terms: ['goalReached', graph.goal] });
    const completed = graph.terminal.reduce((sum, id) => sum + value(id), 0);
    if (completed > 0) out.push({ name: 'headline:completed', terms: ['completed', ...graph.terminal] });
    return out;
  };

  const derive = (relations: { terms: (string | null)[] }[], known: Map<string, number>): Set<string> => {
    const derived = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of relations) {
        const terms = relation.terms.filter((term): term is string => term !== null);
        const unknown = terms.filter((term) => !known.has(term) && !derived.has(term));
        if (unknown.length !== 1 || terms.length < 2) continue;
        const target = unknown[0]!;
        const others = terms.filter((term) => term !== target);
        if (!others.every((term) => known.has(term))) continue;
        const total = known.get(terms[0]!) ?? 0;
        known.set(target, total - others.reduce((sum, term) => sum + (known.get(term) ?? 0), 0));
        derived.add(target);
        changed = true;
      }
    }
    return derived;
  };

  it('never derives a hidden count below k in random chains, forks, merges and exits', () => {
    const random = seededRandom();
    let withHidden = 0;
    for (let run = 0; run < 120; run++) {
      const graph = makeGraph(random);
      const value = (id: string) => graph.counts.get(id) ?? 0;
      const hidden = new Set(graph.nodes.filter((node) => value(node.id) < 5 && random() < 0.6).map((node) => node.id));
      if (!hidden.size) continue;
      withHidden += 1;
      const steps = graph.nodes.map((node) => ({ step: node.id, reached: hidden.has(node.id) ? null : value(node.id) }));
      const totals = {
        entered: value('n0'),
        goalReached: graph.goal ? value(graph.goal) : 0,
        completed: graph.terminal.reduce((sum, id) => sum + value(id), 0),
        exited: 0,
      };
      const result = planJourneyFunnelSuppression({ totals, steps, topology: graph.nodes, k: 5 });
      // The planner may have hidden more; the solver sees only what the response prints.
      const known = new Map<string, number>();
      for (const step of result.steps) if (step.reached !== null) known.set(step.step, step.reached);
      for (const [name, count] of Object.entries(result.totals)) if (count !== null) known.set(name, count);
      const derived = derive(relationsOf(graph), known);
      for (const id of hidden) {
        if (value(id) >= 5) continue;
        expect(derived.has(id), `run ${run}: hidden ${id}=${value(id)} was derived`).toBe(false);
      }
    }
    // The property is only meaningful if the generator actually produced hidden steps.
    expect(withHidden).toBeGreaterThan(10);
  });

  it('keeps two exits from leaking through completed, as a named regression', () => {
    // trigger → fork → A → exitA / B → exitB; all 100 complete, A and exitA reach 97, B and exitB 3.
    const graph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', children: ['fork'] },
        { id: 'fork', kind: 'split', children: ['a', 'b'] },
        { id: 'a', kind: 'wait', children: ['exitA'] },
        { id: 'b', kind: 'wait', children: ['exitB'] },
        { id: 'exitA', kind: 'exit', children: [] },
        { id: 'exitB', kind: 'exit', children: [] },
      ],
      counts: new Map([
        ['trigger', 100],
        ['fork', 100],
        ['a', 97],
        ['b', 3],
        ['exitA', 97],
        ['exitB', 3],
      ]),
      terminal: ['exitA', 'exitB'],
    };
    const hidden = new Set(['b', 'exitB']);
    const steps = graph.nodes.map((node) => ({ step: node.id, reached: hidden.has(node.id) ? null : graph.counts.get(node.id)! }));
    const result = planJourneyFunnelSuppression({
      totals: { entered: 100, goalReached: 0, completed: 100, exited: 0 },
      steps,
      topology: graph.nodes,
      k: 5,
    });
    // The exit relation hides the visible exit with the hidden one, and the fork hides A with B.
    expect(result.steps.find((step) => step.step === 'exitA')?.reached).toBeNull();
    expect(result.steps.find((step) => step.step === 'a')?.reached).toBeNull();
    expect(result.totals.completed).toBe(100);
    const visible = [
      ...result.steps.flatMap((step) => (step.reached === null ? [] : [step.reached])),
      ...Object.values(result.totals).flatMap((count) => (count === null ? [] : [count])),
    ];
    const differences = visible.flatMap((x) => visible.filter((y) => y !== x).map((y) => Math.abs(x - y)));
    expect(differences).not.toContain(3);
  });
});
