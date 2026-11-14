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

// The oracle for the round-5 rule is indistinguishability, not a relation model: move one
// participant under the parent of a hidden step and the visible response must not change. It also
// fails on the old per-relation planner (the negative control), so it has teeth.
describe('journey funnel response is indistinguishable under one participant moved (#908 review round 5)', () => {
  type GraphNode = { id: string; kind: 'trigger' | 'wait' | 'email' | 'goal' | 'exit'; children: string[] };
  type Walk = { visited: string[]; converted: boolean };
  type Population = { nodes: GraphNode[]; walks: Walk[] };
  type Plan = typeof planJourneyFunnelSuppression;

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
  /** What a caller sees: the plan, the drop-offs the handler derives, and the counts it reports. */
  const response = (population: Population, plan: Plan) => {
    const reach = reachOf(population);
    // The handler prints steps in the published walk order, so the oracle does too.
    const steps = population.nodes.filter((node) => reach.has(node.id)).map((node) => ({ step: node.id, reached: reach.get(node.id)! }));
    const result = plan({ totals: totalsOf(population), steps, topology: population.nodes, k: 5 });
    const entered = result.totals.entered;
    let previous: number | null = entered;
    let monotone = true;
    for (const step of result.steps) {
      if (step.reached === null) continue;
      if (previous !== null && step.reached > previous) monotone = false;
      previous = step.reached;
    }
    let previousReach: number | null = entered;
    const derived = result.steps.map((step) => {
      const dropOff = monotone && previousReach !== null && step.reached !== null ? previousReach - step.reached : null;
      const dropOffRate = dropOff === null || previousReach === null || previousReach === 0 ? null : dropOff / previousReach;
      previousReach = step.reached;
      return { step: step.step, reached: step.reached, dropOff, dropOffRate };
    });
    return {
      totals: result.totals,
      steps: derived,
      hiddenParents: result.hiddenParents,
      allStepsHidden: result.allStepsHidden,
      withheld: result.withheld,
      suppressed: derived.filter((step) => step.reached === null).length + result.withheld.length,
    };
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
  /** First-child descent from a node inside `allowed`, ending at a terminal, without revisiting. */
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
   * the parent into it, or (when everyone already takes that branch) out of it. Returns null when no
   * safe move keeps the hidden step below k.
   */
  const reroute = (population: Population, step: string, parent: string): Population | null => {
    const reach = reachOf(population);
    const count = reach.get(step) ?? 0;
    // Only move participants inside the parent's subtree: every row that changes is hidden by the
    // rule, so a loop that could leave the subtree is not followed here.
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
    // Move a participant from another branch below the parent into the hidden step's branch.
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
    // Move a participant who is waiting at the parent into the hidden step's branch.
    const waiting = walks.findIndex((walk) => walk.visited[walk.visited.length - 1] === parent);
    if (waiting >= 0 && count + 1 < 5) {
      const walk = walks[waiting]!;
      walk.visited = [...walk.visited, ...path, ...descend(population.nodes, step, allowed).slice(1)];
      return { nodes: population.nodes, walks };
    }
    // Everyone already takes that branch: move one out, keeping the step below k.
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

  /** A random graph with forks, nested forks, merges, a loop, e-mail nodes, waits and a goal split. */
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
    // A goal with a matched and a timeout exit.
    if (leaves.length) {
      const parent = leaves[int(leaves.length)]!;
      const goal = add('goal');
      nodes.find((node) => node.id === parent)!.children.push(goal);
      const matched = add('exit');
      const timeout = add('exit');
      nodes.find((node) => node.id === goal)!.children.push(matched, timeout);
      leaves.splice(leaves.indexOf(parent), 1, matched, timeout);
    }
    // One loop back to an earlier non-trigger node.
    if (nodes.length > 4) {
      const from = nodes[3 + int(nodes.length - 4)]!;
      const to = nodes[1 + int(3)]!;
      if (from !== to && !from.children.includes(to.id) && from.kind !== 'exit') from.children.push(to.id);
    }

    const walks: Walk[] = [];
    for (let person = 0; person < 40 + int(120); person++) {
      let current: string | undefined = 'n0';
      const visited: string[] = [];
      let converted = false;
      for (let guard = 0; current && guard < 250; guard++) {
        const node = nodes.find((entry) => entry.id === current);
        if (!node) break;
        visited.push(node.id);
        if (node.kind === 'wait' && random() < 0.12) break; // still waiting here
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

  /** The old per-relation planner, for the negative control only. */
  const legacyPlan: Plan = (input) => {
    const k = input.k ?? 5;
    const steps = input.steps.map((step) => ({ ...step }));
    const hidden = new Set(
      steps.filter((step) => step.reached === null || (step.reached > 0 && step.reached < k)).map((step) => step.step),
    );
    const count = (id: string) => steps.find((step) => step.step === id)?.reached ?? 0;
    let changed = true;
    while (changed && input.topology) {
      changed = false;
      for (const node of input.topology) {
        const relations: string[][] = [];
        if (node.children.length >= 2) relations.push([node.id, ...node.children]);
        const parents = input.topology.filter((parent) => parent.children.includes(node.id)).map((parent) => parent.id);
        if (parents.length >= 2) relations.push([node.id, ...parents]);
        for (const relation of relations) {
          const terms = relation.filter((id) => steps.some((step) => step.step === id));
          if (terms.filter((id) => hidden.has(id)).length !== 1) continue;
          const visible = terms.filter((id) => !hidden.has(id) && count(id) > 0).sort((a, b) => count(a) - count(b));
          if (!visible.length) continue;
          hidden.add(visible[0]!);
          changed = true;
        }
      }
    }
    let hiddenSteps = 0;
    for (const step of steps)
      if (hidden.has(step.step)) {
        if (step.reached !== null) hiddenSteps += 1;
        step.reached = null;
      }
    const totals = { ...input.totals };
    for (const name of ['entered', 'goalReached', 'completed', 'exited'] as const)
      if (totals[name] !== null && totals[name]! > 0 && totals[name]! < k) totals[name] = null;
    if (steps.some((step) => step.reached === null))
      for (const name of ['entered', 'goalReached', 'completed', 'exited'] as const) totals[name] = null;
    return { totals, steps, withheld: [], hiddenSteps, hiddenParents: [], allStepsHidden: false };
  };

  it('keeps every visible field equal while a hidden step count changes', () => {
    const random = seededRandom();
    let exercised = 0;
    for (let run = 0; run < 300 && exercised < 60; run++) {
      const population = randomPopulation(random);
      const reach = reachOf(population);
      const primary = [...reach].filter(([, value]) => value > 0 && value < 5);
      for (const [step] of primary) {
        const parents = population.nodes.filter((node) => node.children.includes(step)).map((node) => node.id);
        if (!parents.length) continue;
        const rerouted = reroute(population, step, parents[0]!);
        if (!rerouted) continue;
        const before = reachOf(population).get(step) ?? 0;
        const after = reachOf(rerouted).get(step) ?? 0;
        if (before === after || after <= 0 || after >= 5) continue;
        // A step row that no longer has participants would disappear from the response, which is a
        // different topology of rows; compare populations with the same set of printed rows.
        if ([...reachOf(rerouted).keys()].sort().join(',') !== [...reachOf(population).keys()].sort().join(',')) continue;
        expect(response(rerouted, planJourneyFunnelSuppression)).toEqual(response(population, planJourneyFunnelSuppression));
        exercised += 1;
      }
    }
    expect(exercised).toBeGreaterThan(20);
  });

  it('fails on the old per-relation planner (negative control), so the oracle has teeth', () => {
    const nodes: GraphNode[] = [
      { id: 'trigger', kind: 'trigger', children: ['fork'] },
      { id: 'fork', kind: 'wait', children: ['small_exit', 'a_large'] },
      { id: 'a_large', kind: 'email', children: ['z_end'] },
      { id: 'small_exit', kind: 'exit', children: [] },
      { id: 'z_end', kind: 'exit', children: [] },
    ];
    const walkOf = (path: string[]): Walk => ({ visited: path, converted: false });
    const population: Population = {
      nodes,
      walks: [
        ...Array.from({ length: 99 }, () => walkOf(['trigger', 'fork', 'a_large', 'z_end'])),
        walkOf(['trigger', 'fork', 'small_exit']),
      ],
    };
    const rerouted = reroute(population, 'small_exit', 'fork');
    expect(rerouted).not.toBeNull();
    expect(reachOf(rerouted!).get('small_exit')).not.toBe(reachOf(population).get('small_exit'));
    // The new rule is indistinguishable; the old planner's response changes with the population.
    expect(response(rerouted!, planJourneyFunnelSuppression)).toEqual(response(population, planJourneyFunnelSuppression));
    expect(response(rerouted!, legacyPlan)).not.toEqual(response(population, legacyPlan));
  });
});
