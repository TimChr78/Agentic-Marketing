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

// #908, #917 review round 4: step rows are protected along the published topology (forks and
// merges only). How a headline relates to the steps is not knowable in general — goalReached counts
// matches, not the goal step's reach; completed can be recorded at several nodes; exited anywhere —
// so once any step row is hidden, every headline total is withheld. Over-suppression is deliberate.
describe('journey funnel totals follow the k floor (#908)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });

  it('withholds every headline when a step row is hidden, even without a topology', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: [
        { step: 'a', reached: 100 },
        { step: 'b', reached: null },
      ],
      topology: null,
    });
    // No relations without a topology, so no complementary step is invented; the totals go instead.
    expect(result.steps.map((step) => step.reached)).toEqual([100, null]);
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
    expect(result.withheld).toEqual(['entered', 'goalReached', 'completed', 'exited']);
    expect(result.complementary).toBe(false);
  });

  it('leaves a funnel with every step visible untouched', () => {
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
  });

  it('withholds a positive headline below k even when every step is visible', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 3, completed: 100, exited: 0 },
      steps: [{ step: 'a', reached: 100 }],
      topology: null,
    });
    expect(result.totals).toEqual({ entered: 100, goalReached: null, completed: 100, exited: 0 });
    expect(result.withheld).toEqual(['goalReached']);
  });

  it('returns zero rows with zero headlines unchanged', () => {
    const result = plan({
      totals: { entered: 0, goalReached: 0, completed: 0, exited: 0 },
      steps: [],
      topology: [
        { id: 'start', kind: 'trigger', children: ['a'] },
        { id: 'a', kind: 'wait', children: [] },
      ],
    });
    expect(result.totals).toEqual({ entered: 0, goalReached: 0, completed: 0, exited: 0 });
    expect(result.steps).toEqual([]);
    expect(result.withheld).toEqual([]);
  });
});

// Step-row suppression follows the topology: a hidden branch must hide a sibling in the same fork
// (or merge), never an unrelated step, so the parent cannot hand it back.
describe('journey funnel suppression follows the published topology (#908 review)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });
  const node = (id: string, kind: string, children: string[] = []) => ({ id, kind, children });
  const steps = (values: Record<string, number | null>) => Object.entries(values).map(([step, reached]) => ({ step, reached }));
  /** Every arithmetic difference between the visible step numbers in the response. */
  const differences = (result: ReturnType<typeof plan>): number[] => {
    const visible = result.steps.flatMap((step) => (step.reached === null ? [] : [step.reached]));
    const out: number[] = [];
    for (const a of visible) for (const b of visible) if (a !== b) out.push(Math.abs(a - b));
    return out;
  };

  it('protects the branch Sol reported: 100 fork, A 97, A downstream 5, B 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, a_down: 5, b: null }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['a_down']), node('a_down', 'wait'), node('b', 'wait')],
    });
    // B was hidden; A is the only visible sibling in the same fork, so A is hidden with it.
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, 5, null]);
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
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60, null, null]);
    expect(differences(result)).not.toContain(4);
  });

  it('leaves a linear chain alone (no sibling to hide) and withholds its totals', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, s1: 60, s2: null, s3: 55 }),
      topology: [node('start', 'trigger', ['s1']), node('s1', 'wait', ['s2']), node('s2', 'wait', ['s3']), node('s3', 'wait')],
    });
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60, null, 55]);
    expect(result.complementary).toBe(false);
    expect(result.totals.entered).toBeNull();
  });

  it('hides nothing more when two siblings are already hidden', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: null, b: null }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait'), node('b', 'wait')],
    });
    expect(result.steps.map((step) => step.reached)).toEqual([100, null, null]);
    expect(result.complementary).toBe(false);
    expect(result.totals.entered).toBeNull();
  });

  it('protects a reconvergence: join 100, arm A 97, arm B 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, b: null, join: 100 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['join']), node('b', 'wait', ['join']), node('join', 'wait')],
    });
    expect(result.steps.find((step) => step.step === 'a')?.reached).toBeNull();
    expect(result.steps.find((step) => step.step === 'join')?.reached).toBe(100);
    expect(differences(result)).not.toContain(3);
  });
});

// #917 review round 4: the goal/timeout split showed why a headline cannot be modelled. 100 enter,
// 97 match the goal and 3 time out: goalReached = 97 while the goal step's reach is 100, so a
// completed = 100 beside a visible exit gave the hidden timeout exit as 100 - 97.
describe('journey funnel headlines are withheld when a step is hidden (#908 review round 4)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });
  const node = (id: string, kind: string, children: string[] = []) => ({ id, kind, children });
  const steps = (values: Record<string, number | null>) => Object.entries(values).map(([step, reached]) => ({ step, reached }));

  it('withholds every headline in the goal/timeout topology, so 100 − 97 cannot give 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 97, completed: 100, exited: 0 },
      steps: steps({ trigger: 100, goal: 100, matchedExit: null, timeoutExit: null }),
      topology: [
        node('trigger', 'trigger', ['goal']),
        node('goal', 'goal', ['matchedExit', 'timeoutExit']),
        node('matchedExit', 'exit'),
        node('timeoutExit', 'exit'),
      ],
    });
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
    const visible = result.steps.flatMap((step) => (step.reached === null ? [] : [step.reached]));
    const differences = visible.flatMap((x) => visible.filter((y) => y !== x).map((y) => Math.abs(x - y)));
    expect(differences).not.toContain(3);
  });

  it('keeps two exits from leaking through completed', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 100, exited: 0 },
      steps: steps({ trigger: 100, fork: 100, a: 97, b: null, exitA: 97, exitB: null }),
      topology: [
        node('trigger', 'trigger', ['fork']),
        node('fork', 'split', ['a', 'b']),
        node('a', 'wait', ['exitA']),
        node('b', 'wait', ['exitB']),
        node('exitA', 'exit'),
        node('exitB', 'exit'),
      ],
    });
    // The fork has two hidden terms (A and B), so no fork relation can recover either; the headline
    // that used to combine the exits is withheld.
    expect(result.steps.find((step) => step.step === 'a')?.reached).toBeNull();
    expect(result.steps.find((step) => step.step === 'b')?.reached).toBeNull();
    expect(result.totals.completed).toBeNull();
  });
});

// The property test does not share the planner's model: it generates a topology (including goal
// nodes with a matched/timeout split), simulates each participant walking the graph with the
// interpreter's counting rules, then runs the planner and checks the printed response.
describe('journey funnel suppression cannot be bypassed (#908 property test)', () => {
  type Node = { id: string; kind: string; children: string[] };
  type Sim = {
    nodes: Node[];
    reach: Map<string, number>;
    totals: { entered: number; goalReached: number; completed: number; exited: number };
  };

  const simulate = (random: () => number): Sim => {
    const int = (max: number) => Math.floor(random() * max);
    const nodes: Node[] = [{ id: 'n0', kind: 'trigger', children: [] }];
    const nextId = () => `n${nodes.length}`;
    const add = (kind = 'wait') => {
      const id = nextId();
      nodes.push({ id, kind, children: [] });
      return id;
    };
    const leaves = ['n0'];
    const participants = 40 + int(160);
    const walks: { visited: string[]; converted: boolean; completed: boolean }[] = [];
    // Build a layered graph first: random chain/fork/merge growth, then simulate the walk on it.
    for (let step = 0; step < 6 + int(6); step++) {
      const roll = random();
      if (roll < 0.4 && leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const kids = 2 + int(2);
        for (let i = 0; i < kids; i++) {
          const id = add();
          nodes.find((node) => node.id === parent)!.children.push(id);
          leaves.push(id);
        }
        leaves.splice(leaves.indexOf(parent), 1);
      } else if (roll < 0.65 && leaves.length >= 2) {
        const first = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(first), 1);
        const second = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(second), 1);
        const id = add();
        for (const parent of [first, second]) nodes.find((node) => node.id === parent)!.children.push(id);
        leaves.push(id);
      } else if (leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const id = add();
        nodes.find((node) => node.id === parent)!.children.push(id);
        leaves.splice(leaves.indexOf(parent), 1, id);
      }
    }
    // A goal node with a matched and a timeout exit, when it can be placed on a leaf.
    const goalParent = leaves.length ? leaves[int(leaves.length)]! : undefined;
    if (goalParent !== undefined) {
      const goal = add('goal');
      nodes.find((node) => node.id === goalParent)!.children.push(goal);
      const matched = add('exit');
      const timeout = add('exit');
      nodes.find((node) => node.id === goal)!.children.push(matched, timeout);
      leaves.splice(leaves.indexOf(goalParent), 1, matched, timeout);
    }

    for (let person = 0; person < participants; person++) {
      let current: string | undefined = 'n0';
      const visited: string[] = [];
      let converted = false;
      for (let guard = 0; current && guard < 200; guard++) {
        const node = nodes.find((entry) => entry.id === current)!;
        visited.push(node.id);
        if (node.kind === 'goal') {
          // Match or time out; a match records `converted` at the goal node and takes the matched
          // edge, a timeout takes the other one. The goal step itself is reached either way.
          const matched = random() < 0.5;
          if (matched) converted = true;
          current = node.children.length > 1 ? node.children[matched ? 0 : 1] : node.children[0];
          continue;
        }
        if (node.children.length === 0) break;
        current = node.children[int(node.children.length)];
      }
      walks.push({
        visited,
        converted,
        completed: current === undefined ? true : nodes.find((node) => node.id === current)?.children.length === 0,
      });
    }

    const reach = new Map<string, number>();
    for (const walk of walks) for (const id of new Set(walk.visited)) reach.set(id, (reach.get(id) ?? 0) + 1);
    // `completed` is recorded at the node where the walk ends (exit or no outgoing edge).
    const completed = walks.filter((walk) => walk.completed).length;
    return {
      nodes,
      reach,
      totals: {
        entered: reach.get('n0') ?? 0,
        goalReached: walks.filter((walk) => walk.converted).length,
        completed,
        exited: 0,
      },
    };
  };

  const stepRelations = (nodes: Node[]): string[][] => {
    const out: string[][] = [];
    for (const node of nodes) {
      if (node.children.length >= 2) out.push([node.id, ...node.children]);
      const parents = nodes.filter((parent) => parent.children.includes(node.id));
      if (parents.length >= 2) out.push([node.id, ...parents.map((parent) => parent.id)]);
    }
    return out;
  };

  const derive = (relations: string[][], known: Map<string, number>): Set<string> => {
    const derived = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of relations) {
        const unknown = relation.filter((term) => !known.has(term) && !derived.has(term));
        if (unknown.length !== 1) continue;
        const target = unknown[0]!;
        const others = relation.filter((term) => term !== target);
        if (!others.every((term) => known.has(term))) continue;
        known.set(target, (known.get(relation[0]!) ?? 0) - others.reduce((sum, term) => sum + (known.get(term) ?? 0), 0));
        derived.add(target);
        changed = true;
      }
    }
    return derived;
  };

  it('withholds every headline for a hidden step, and no fork/merge derivation recovers it', () => {
    const random = seededRandom();
    let withHidden = 0;
    for (let run = 0; run < 120; run++) {
      const graph = simulate(random);
      const hidden = new Set([...graph.reach].filter(([, count]) => count < 5 && random() < 0.6).map(([id]) => id));
      if (!hidden.size) continue;
      withHidden += 1;
      const steps = graph.nodes
        .filter((node) => graph.reach.has(node.id))
        .map((node) => ({ step: node.id, reached: hidden.has(node.id) ? null : (graph.reach.get(node.id) ?? 0) }));
      const result = planJourneyFunnelSuppression({ totals: graph.totals, steps, topology: graph.nodes, k: 5 });
      // Any hidden step row must withhold every headline.
      const anyStepHidden = result.steps.some((step) => step.reached === null);
      expect(anyStepHidden).toBe(true);
      expect(Object.values(result.totals)).toEqual([null, null, null, null]);
      // The solver sees only the visible step numbers and the fork/merge relations.
      const known = new Map<string, number>();
      for (const step of result.steps) if (step.reached !== null) known.set(step.step, step.reached);
      const derived = derive(stepRelations(graph.nodes), known);
      for (const id of hidden) {
        if ((graph.reach.get(id) ?? 0) >= 5) continue;
        expect(derived.has(id), `run ${run}: hidden ${id}=${graph.reach.get(id)} was derived`).toBe(false);
      }
    }
    expect(withHidden).toBeGreaterThan(10);
  });
});
