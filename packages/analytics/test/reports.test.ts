import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test-support/index';
import { analyticsCampaignSummary } from '../src/campaignSummary';
import { analyticsReports, buildJourneyFunnel, planJourneyFunnelSuppression } from '../src/reports';

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

// #908, #917 review round 5: a below-k step hides the whole subtree under its parent, so every
// branch that could change when one participant moves under that parent is hidden. Headlines are
// withheld whenever any step is hidden.
describe("journey funnel's subtree rule and headlines (#908 review round 5)", () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });
  const node = (id: string, kind: string, children: string[] = []) => ({ id, kind, children });
  const steps = (values: Record<string, number | null>) => Object.entries(values).map(([step, reached]) => ({ step, reached }));
  const reachedOf = (result: ReturnType<typeof plan>) => Object.fromEntries(result.steps.map((step) => [step.step, step.reached]));
  const visibleNumbers = (result: ReturnType<typeof plan>) => [
    ...result.steps.flatMap((step) => (step.reached === null ? [] : [step.reached])),
    ...Object.values(result.totals).flatMap((value) => (value === null ? [] : [value])),
  ];
  const differences = (values: number[]) => values.flatMap((a) => values.filter((b) => b !== a).map((b) => Math.abs(a - b)));

  it('hides every descendant of the parent, so a same-advance e-mail step cannot hand back 1 (#917 review round 5)', () => {
    // trigger(100) → fork(100) → smallExit(1) and → aLarge(99, e-mail) → zEnd(99), recorded together.
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 100, exited: 0 },
      steps: steps({ trigger: 100, fork: 100, smallExit: 1, aLarge: 99, zEnd: 99 }),
      topology: [
        node('trigger', 'trigger', ['fork']),
        node('fork', 'split', ['smallExit', 'aLarge']),
        node('aLarge', 'email', ['zEnd']),
        node('smallExit', 'exit'),
        node('zEnd', 'exit'),
      ],
    });
    const reached = reachedOf(result);
    expect(reached.smallExit).toBeNull();
    expect(reached.aLarge).toBeNull();
    expect(reached.zEnd).toBeNull();
    // The parent and everything above it stay visible; 99 appears nowhere.
    expect(reached.trigger).toBe(100);
    expect(reached.fork).toBe(100);
    expect(visibleNumbers(result)).not.toContain(99);
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
    expect(result.hiddenParents).toEqual(['fork']);
  });

  it('protects the round-4 fork: 100 fork, A 97, A downstream 5, B 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, a_down: 5, b: 3 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['a_down']), node('a_down', 'wait'), node('b', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, a: null, a_down: null, b: null });
    expect(differences(visibleNumbers(result))).not.toContain(3);
  });

  it('hides both branches of a two-way fork', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, b: 3 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait'), node('b', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, a: null, b: null });
  });

  it('hides every branch of a three-way fork with one small branch', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 60, b: 30, c: 4 }),
      topology: [node('start', 'trigger', ['a', 'b', 'c']), node('a', 'wait'), node('b', 'wait'), node('c', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, a: null, b: null, c: null });
    expect(differences(visibleNumbers(result))).not.toContain(4);
  });

  it('hides the rest of a linear chain after the parent of the small step', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, s1: 60, s2: 3, s3: 55 }),
      topology: [node('start', 'trigger', ['s1']), node('s1', 'wait', ['s2']), node('s2', 'wait', ['s3']), node('s3', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, s1: 60, s2: null, s3: null });
  });

  it('hides both small siblings with their parent subtree', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 3, b: 4 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait'), node('b', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, a: null, b: null });
  });

  it('hides a reconverged subtree from its parent', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 97, b: 3, join: 100 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['join']), node('b', 'wait', ['join']), node('join', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ start: 100, a: null, b: null, join: null });
  });

  it('hides all steps when the small step is an entry with no parent', () => {
    const result = plan({
      totals: { entered: 3, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ trigger: 3, a: 100 }),
      topology: [node('trigger', 'trigger', ['a']), node('a', 'wait')],
    });
    expect(result.steps.every((step) => step.reached === null)).toBe(true);
    expect(result.allStepsHidden).toBe(true);
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
  });

  it('hides all steps and headlines when there is no published topology', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: steps({ a: 100, b: 3 }),
      topology: null,
    });
    expect(result.steps.map((step) => step.reached)).toEqual([null, null]);
    expect(result.allStepsHidden).toBe(true);
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
  });

  it('does not treat a zero row as below k', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: steps({ a: 100, b: 0 }),
      topology: [node('start', 'trigger', ['a']), node('a', 'wait', ['b']), node('b', 'wait')],
    });
    expect(reachedOf(result)).toEqual({ a: 100, b: 0 });
    expect(result.totals).toEqual({ entered: 100, goalReached: 60, completed: 50, exited: 10 });
  });

  it('leaves a funnel with every step visible untouched', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 60, completed: 50, exited: 10 },
      steps: steps({ a: 100, b: 60 }),
      topology: [node('start', 'trigger', ['a']), node('a', 'wait', ['b']), node('b', 'wait')],
    });
    expect(result.totals).toEqual({ entered: 100, goalReached: 60, completed: 50, exited: 10 });
    expect(result.steps.map((step) => step.reached)).toEqual([100, 60]);
  });

  it('withholds a positive headline below k even when every step is visible', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 3, completed: 100, exited: 0 },
      steps: [{ step: 'a', reached: 100 }],
      topology: [node('start', 'trigger', ['a']), node('a', 'wait')],
    });
    expect(result.totals).toEqual({ entered: 100, goalReached: null, completed: 100, exited: 0 });
    expect(result.withheld).toEqual(['goalReached']);
  });

  it('terminates a loop while hiding the subtree', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 99, b: 3 }),
      topology: [node('start', 'trigger', ['a']), node('a', 'wait', ['b']), node('b', 'wait', ['a'])],
    });
    // b is below k and its parent a loops back to itself; a stays visible, b hides.
    expect(reachedOf(result)).toEqual({ start: 100, a: 99, b: null });
  });

  it('hides a primary row whose only parent is itself (disconnected self-loop) (#917 review round 6)', () => {
    // trigger(100) -> end(100) plus a disconnected wait node h whose only parent is itself, h(3).
    // `journeys.migrate` can move participants to h; the row must not print its own count.
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 100, exited: 0 },
      steps: steps({ trigger: 100, end: 100, h: 3 }),
      topology: [node('trigger', 'trigger', ['end']), node('end', 'exit'), node('h', 'wait', ['h'])],
    });
    expect(reachedOf(result)).toEqual({ trigger: 100, end: 100, h: null });
    expect(result.hiddenNodes).toContain('h');
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
  });

  it('prints every published step under a hidden parent, even without a row', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, small: 3 }),
      topology: [
        node('start', 'trigger', ['small', 'quiet']),
        node('small', 'wait', ['deep']),
        node('quiet', 'wait'),
        node('deep', 'wait'),
      ],
    });
    // `quiet` and `deep` have no events but are under the hidden parent start, so they are printed
    // suppressed rather than missing (presence must not change with a participant's move).
    expect(result.hiddenNodes).toEqual(expect.arrayContaining(['small', 'quiet', 'deep']));
    expect(result.hiddenNodes).not.toContain('start');
  });

  it('hides the subtree under every parent of a merged small step', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 0, completed: 0, exited: 0 },
      steps: steps({ start: 100, a: 50, b: 50, small: 3 }),
      topology: [node('start', 'trigger', ['a', 'b']), node('a', 'wait', ['small']), node('b', 'wait', ['small']), node('small', 'wait')],
    });
    // small has two parents (a and b); descendants of each are hidden, so both parents stay visible.
    expect(reachedOf(result)).toEqual({ start: 100, a: 50, b: 50, small: null });
    expect(result.hiddenParents).toEqual(['a', 'b']);
  });

  it('returns zero rows with zero headlines unchanged', () => {
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

// The goal/timeout split is the reason headlines are not modelled at all.
describe('journey funnel headlines are withheld when a step is hidden (#908 review round 4)', () => {
  const plan = (input: Parameters<typeof planJourneyFunnelSuppression>[0]) => planJourneyFunnelSuppression({ k: 5, ...input });
  const node = (id: string, kind: string, children: string[] = []) => ({ id, kind, children });
  const steps = (values: Record<string, number | null>) => Object.entries(values).map(([step, reached]) => ({ step, reached }));

  it('withholds every headline in the goal/timeout topology, so 100 − 97 cannot give 3', () => {
    const result = plan({
      totals: { entered: 100, goalReached: 97, completed: 100, exited: 0 },
      steps: steps({ trigger: 100, goal: 100, matched_exit: 97, timeout_exit: 3 }),
      topology: [
        node('trigger', 'trigger', ['goal']),
        node('goal', 'goal', ['matched_exit', 'timeout_exit']),
        node('matched_exit', 'exit'),
        node('timeout_exit', 'exit'),
      ],
    });
    expect(result.totals).toEqual({ entered: null, goalReached: null, completed: null, exited: null });
    const reached = Object.fromEntries(result.steps.map((step) => [step.step, step.reached]));
    expect(reached.matched_exit).toBeNull();
    expect(reached.timeout_exit).toBeNull();
  });
});

// The oracle for the round-5 rule is indistinguishability of the COMPLETE response, built by the
// same pure function the command handler uses. Move one participant under the parent of a hidden
// step and every visible field must stay equal while the hidden count differs. The negative
// control runs the old per-relation planner and shows the oracle fails on Sol's graph.
describe('journey funnel response is indistinguishable under one participant moved (#908 review round 5)', () => {
  type GraphNode = { id: string; kind: 'trigger' | 'wait' | 'email' | 'goal' | 'exit'; children: string[] };
  type Walk = { visited: string[]; converted: boolean };
  type Population = { nodes: GraphNode[]; walks: Walk[] };

  const meta = {
    timeZone: 'UTC',
    currency: null,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T00:00:00.000Z',
    freshness: null,
    suppressed: 0,
    k: 5,
    notes: [] as string[],
  };
  const reachOf = (population: Population): Map<string, number> => {
    const reach = new Map<string, number>();
    for (const walk of population.walks) for (const id of new Set(walk.visited)) reach.set(id, (reach.get(id) ?? 0) + 1);
    return reach;
  };
  const totalsOf = (population: Population) => {
    const reach = reachOf(population);
    return {
      entered: reach.get(population.nodes[0]!.id) ?? 0,
      goalReached: population.walks.filter((walk) => walk.converted).length,
      completed: population.walks.filter((walk) => {
        const last = walk.visited[walk.visited.length - 1];
        return last !== undefined && (population.nodes.find((node) => node.id === last)?.children.length ?? 1) === 0;
      }).length,
      exited: 0,
    };
  };
  const linearOf = (nodes: GraphNode[]) =>
    nodes.every((node, index) =>
      index === nodes.length - 1 ? node.children.length === 0 : node.children.length === 1 && node.children[0] === nodes[index + 1]?.id,
    );
  /** The two query results plus the published walk, the way the handler builds them. */
  const response = (population: Population) => {
    const reach = reachOf(population);
    const totals = totalsOf(population);
    return buildJourneyFunnel(
      {
        journeyId: `jrn_${'a'.repeat(32)}`,
        totals: {
          columns: [
            { name: 'journey.entered', kind: 'measure', unit: 'count' },
            { name: 'journey.goal_reached', kind: 'measure', unit: 'count' },
            { name: 'journey.completed', kind: 'measure', unit: 'count' },
            { name: 'journey.exited', kind: 'measure', unit: 'count' },
          ],
          rows: [[totals.entered, totals.goalReached, totals.completed, totals.exited]],
          meta: { ...meta },
        },
        steps: {
          columns: [
            { name: 'journey_step', kind: 'dimension' },
            { name: 'journey.step_reached', kind: 'measure', unit: 'count' },
          ],
          rows: population.nodes.filter((node) => reach.has(node.id)).map((node) => [node.id, reach.get(node.id)!]),
          meta: { ...meta },
        },
      },
      { version: 1, order: population.nodes.map((node) => node.id), linear: linearOf(population.nodes), edges: population.nodes },
    );
  };

  /** The path from `from` to `target` inside `allowed`, exclusive of `from`, inclusive of `target`. */
  const pathTo = (nodes: GraphNode[], from: string, target: string, allowed: Set<string>): string[] | null => {
    const queue: string[][] = [[from]];
    const seen = new Set([from]);
    while (queue.length) {
      const path = queue.shift()!;
      const id = path[path.length - 1]!;
      if (id === target) return path.slice(1);
      for (const child of nodes.find((node) => node.id === id)?.children ?? []) {
        if (seen.has(child) || !allowed.has(child)) continue;
        seen.add(child);
        queue.push([...path, child]);
      }
    }
    return null;
  };
  const descend = (nodes: GraphNode[], from: string, allowed: Set<string>): string[] => {
    const out = [from];
    const seen = new Set([from]);
    let id = from;
    for (;;) {
      const child = (nodes.find((node) => node.id === id)?.children ?? []).find((next) => !seen.has(next) && allowed.has(next));
      if (!child) return out;
      seen.add(child);
      out.push(child);
      id = child;
    }
  };
  /**
   * Move one participant under `parent`: from another branch into `step`'s branch, from waiting at
   * the parent into it, or out of it. Null when no safe move keeps the step below k.
   */
  const reroute = (population: Population, step: string, parent: string): Population | null => {
    const reach = reachOf(population);
    const count = reach.get(step) ?? 0;
    const allowed = new Set<string>();
    const queue = [...(population.nodes.find((node) => node.id === parent)?.children ?? [])];
    const seen = new Set([parent]);
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      allowed.add(id);
      queue.push(...(population.nodes.find((node) => node.id === id)?.children ?? []));
    }
    const path = pathTo(population.nodes, parent, step, allowed);
    if (!path) return null;
    const branch = path[0]!;
    const walks = population.walks.map((walk) => ({ ...walk, visited: [...walk.visited] }));
    const fromOther = walks.findIndex((walk) => {
      const at = walk.visited.lastIndexOf(parent);
      return at >= 0 && walk.visited[at + 1] !== undefined && walk.visited[at + 1] !== branch;
    });
    if (fromOther >= 0 && count + 1 < 5) {
      const walk = walks[fromOther]!;
      const at = walk.visited.lastIndexOf(parent);
      walk.visited = [...walk.visited.slice(0, at + 1), ...path, ...descend(population.nodes, step, allowed).slice(1)];
      return { nodes: population.nodes, walks };
    }
    const waiting = walks.findIndex((walk) => walk.visited[walk.visited.length - 1] === parent);
    if (waiting >= 0 && count + 1 < 5) {
      const walk = walks[waiting]!;
      walk.visited = [...walk.visited, ...path, ...descend(population.nodes, step, allowed).slice(1)];
      return { nodes: population.nodes, walks };
    }
    const inside = walks.findIndex((walk) => {
      const at = walk.visited.lastIndexOf(parent);
      return at >= 0 && walk.visited[at + 1] === branch && walk.visited.includes(step);
    });
    const other = (population.nodes.find((node) => node.id === parent)?.children ?? []).find((child) => child !== branch);
    if (inside >= 0 && other !== undefined && count - 1 > 0) {
      const walk = walks[inside]!;
      const at = walk.visited.lastIndexOf(parent);
      walk.visited = [...walk.visited.slice(0, at + 1), ...descend(population.nodes, other, allowed)];
      return { nodes: population.nodes, walks };
    }
    return null;
  };

  const randomPopulation = (random: () => number): Population => {
    const int = (max: number) => Math.floor(random() * max);
    const nodes: GraphNode[] = [{ id: 'n0', kind: 'trigger', children: [] }];
    const add = (kind: GraphNode['kind'] = 'wait') => {
      const id = `n${nodes.length}`;
      nodes.push({ id, kind, children: [] });
      return id;
    };
    const leaves = ['n0'];
    for (let step = 0; step < 6 + int(6); step++) {
      const roll = random();
      if (roll < 0.4 && leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const kids = 2 + int(2);
        for (let i = 0; i < kids; i++) {
          const id = add(random() < 0.3 ? 'email' : 'wait');
          nodes.find((node) => node.id === parent)!.children.push(id);
          leaves.push(id);
        }
        leaves.splice(leaves.indexOf(parent), 1);
      } else if (roll < 0.6 && leaves.length >= 2) {
        const first = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(first), 1);
        const second = leaves[int(leaves.length)]!;
        leaves.splice(leaves.indexOf(second), 1);
        const id = add();
        for (const parent of [first, second]) nodes.find((node) => node.id === parent)!.children.push(id);
        leaves.push(id);
      } else if (roll < 0.7) {
        // A self-loop on a connected wait node.
        const node = nodes[1 + int(Math.max(1, nodes.length - 1))];
        if (node && node.kind === 'wait' && !node.children.includes(node.id)) node.children.push(node.id);
      } else if (leaves.length) {
        const parent = leaves[int(leaves.length)]!;
        const id = add();
        nodes.find((node) => node.id === parent)!.children.push(id);
        leaves.splice(leaves.indexOf(parent), 1, id);
      }
    }
    if (leaves.length) {
      const parent = leaves[int(leaves.length)]!;
      const goal = add('goal');
      nodes.find((node) => node.id === parent)!.children.push(goal);
      const matched = add('exit');
      const timeout = add('exit');
      nodes.find((node) => node.id === goal)!.children.push(matched, timeout);
      leaves.splice(leaves.indexOf(parent), 1, matched, timeout);
    }
    // A disconnected self-loop that migration can move participants into, and one nobody reaches.
    const migration = add('wait');
    nodes.find((node) => node.id === migration)!.children.push(migration);
    const ghost = add('wait');
    nodes.find((node) => node.id === ghost)!.children.push(ghost);

    const walks: Walk[] = [];
    const migrants = 1 + int(3);
    for (let person = 0; person < 40 + int(120); person++) {
      let current: string | undefined = person < migrants ? migration : 'n0';
      const visited: string[] = [];
      let converted = false;
      for (let guard = 0; current && guard < 250; guard++) {
        const node = nodes.find((entry) => entry.id === current);
        if (!node) break;
        visited.push(node.id);
        if (node.kind === 'wait' && random() < 0.12) break;
        if (node.kind === 'goal') {
          const matched = random() < 0.5;
          if (matched) converted = true;
          current = node.children.length > 1 ? node.children[matched ? 0 : 1] : node.children[0];
          continue;
        }
        if (!node.children.length) break;
        current = node.children[int(node.children.length)];
      }
      walks.push({ visited, converted });
    }
    return { nodes, walks };
  };

  it('keeps the complete response equal while a hidden step count changes', () => {
    const random = seededRandom();
    let exercised = 0;
    for (let run = 0; run < 400 && exercised < 80; run++) {
      const population = randomPopulation(random);
      const reach = reachOf(population);
      const before = response(population);
      // Any primary row (below k) withholds every headline.
      if ([...reach.values()].some((count) => count > 0 && count < 5))
        expect([before.entered, before.goalReached, before.completed, before.exited]).toEqual([null, null, null, null]);
      for (const [step, count] of reach) {
        if (!(count > 0 && count < 5)) continue;
        const parents = population.nodes.filter((node) => node.id !== step && node.children.includes(step)).map((node) => node.id);
        if (!parents.length) continue; // disconnected/self-loop: hidden itself, no move to make
        const rerouted = reroute(population, step, parents[0]!);
        if (!rerouted) continue;
        const after = reachOf(rerouted).get(step) ?? 0;
        if (after === count || after <= 0 || after >= 5) continue;
        expect(response(rerouted)).toEqual(before);
        exercised += 1;
      }
    }
    expect(exercised).toBeGreaterThan(20);
  });

  it('keeps presence stable when a count moves between 0 and 1 under a hidden parent', () => {
    const nodes: GraphNode[] = [
      { id: 'start', kind: 'trigger', children: ['fork'] },
      { id: 'fork', kind: 'wait', children: ['small', 'tiny', 'large'] },
      { id: 'small', kind: 'wait', children: [] },
      { id: 'tiny', kind: 'wait', children: [] },
      { id: 'large', kind: 'wait', children: [] },
    ];
    const walk = (path: string[]): Walk => ({ visited: path, converted: false });
    // Both small and tiny are below k under the hidden fork. Moving tiny's only participant into
    // small leaves tiny with no events, but every published step under the hidden parent is still
    // printed suppressed, so the response does not change.
    const before: Population = {
      nodes,
      walks: [
        ...Array.from({ length: 97 }, () => walk(['start', 'fork', 'large'])),
        walk(['start', 'fork', 'small']),
        walk(['start', 'fork', 'tiny']),
      ],
    };
    const after: Population = {
      nodes,
      walks: [
        ...Array.from({ length: 97 }, () => walk(['start', 'fork', 'large'])),
        ...Array.from({ length: 2 }, () => walk(['start', 'fork', 'small'])),
      ],
    };
    expect(response(before)).toEqual(response(after));
    expect(response(after).steps.find((step) => step.step === 'tiny')).toMatchObject({ reached: null, suppressed: true });
  });

  it('hides a migration into a disconnected self-loop node', () => {
    const nodes: GraphNode[] = [
      { id: 'trigger', kind: 'trigger', children: ['end'] },
      { id: 'end', kind: 'exit', children: [] },
      { id: 'moved', kind: 'wait', children: ['moved'] },
    ];
    const walk = (path: string[]): Walk => ({ visited: path, converted: false });
    const population: Population = {
      nodes,
      walks: [...Array.from({ length: 100 }, () => walk(['trigger', 'end'])), ...Array.from({ length: 3 }, () => walk(['moved']))],
    };
    const result = response(population);
    expect(result.steps.find((step) => step.step === 'moved')).toMatchObject({ reached: null, suppressed: true });
    expect([result.entered, result.goalReached, result.completed, result.exited]).toEqual([null, null, null, null]);
  });

  it('fails on the old per-relation planner (negative control), so the oracle has teeth', () => {
    const nodes: GraphNode[] = [
      { id: 'trigger', kind: 'trigger', children: ['fork'] },
      { id: 'fork', kind: 'wait', children: ['small_exit', 'a_large'] },
      { id: 'a_large', kind: 'email', children: ['z_end'] },
      { id: 'small_exit', kind: 'exit', children: [] },
      { id: 'z_end', kind: 'exit', children: [] },
    ];
    const walk = (path: string[]): Walk => ({ visited: path, converted: false });
    const population: Population = {
      nodes,
      walks: [...Array.from({ length: 99 }, () => walk(['trigger', 'fork', 'a_large', 'z_end'])), walk(['trigger', 'fork', 'small_exit'])],
    };
    const rerouted = reroute(population, 'small_exit', 'fork');
    expect(rerouted).not.toBeNull();
    expect(reachOf(rerouted!).get('small_exit')).not.toBe(reachOf(population).get('small_exit'));
    // The new rule is indistinguishable; the old planner's visible steps change with the population.
    expect(response(rerouted!)).toEqual(response(population));
    const legacy = (value: Population) => {
      const reach = reachOf(value);
      const steps = value.nodes.filter((node) => reach.has(node.id)).map((node) => ({ step: node.id, reached: reach.get(node.id)! }));
      const hidden = new Set(steps.filter((step) => step.reached < 5).map((step) => step.step));
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of value.nodes) {
          const relations: string[][] = [];
          if (node.children.length >= 2) relations.push([node.id, ...node.children]);
          const parents = value.nodes.filter((parent) => parent.children.includes(node.id)).map((parent) => parent.id);
          if (parents.length >= 2) relations.push([node.id, ...parents]);
          for (const relation of relations) {
            const terms = relation.filter((id) => steps.some((step) => step.step === id));
            if (terms.filter((id) => hidden.has(id)).length !== 1) continue;
            const candidates = terms.filter((id) => !hidden.has(id)).sort((a, b) => (reach.get(a) ?? 0) - (reach.get(b) ?? 0));
            if (!candidates.length) continue;
            hidden.add(candidates[0]!);
            changed = true;
          }
        }
      }
      return steps.map((step) => ({ step: step.step, reached: hidden.has(step.step) ? null : step.reached }));
    };
    expect(legacy(rerouted!)).not.toEqual(legacy(population));
  });
});
