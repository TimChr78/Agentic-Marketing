import { artifactTypes } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { analyticsMeta, analyticsResult, K, type QueryInput, runAnalyticsQuery } from './query';

// Named reports are thin, stable wrappers over the same registry and query compiler. They exist so
// an agent or a screen does not have to remember the list of measures, and so the shape of the
// common answers cannot drift.

const EMAIL_MEASURES = [
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
  'email.click_rate',
  'email.bounce_rate',
  'email.complaint_rate',
  'email.unsubscribe_rate',
  'email.open_rate',
];

const emailBy = z.enum(['template', 'broadcast', 'journey', 'day']);

export const analyticsEmailPerformance = defineCommand({
  name: 'analytics.emailPerformance',
  title: 'E-mail performance',
  description:
    'Sent, delivered, bounced, complained, opened, clicked and unsubscribed people, with click, bounce, unsubscribe and open rates, by template, broadcast, journey or day. Opens are only counted where tracking is enabled. Breakdowns hide groups smaller than k=5 and say so in meta.suppressed.',
  input: z.object({
    from: isoDateTime('from'),
    to: isoDateTime('to'),
    by: emailBy.default('day').describe('Breakdown: template, broadcast, journey or day'),
  }),
  output: analyticsResult,
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const query: QueryInput = {
      measures: EMAIL_MEASURES,
      dimensions: [input.by],
      from: input.from,
      to: input.to,
      limit: 5000,
      order: { by: input.by, dir: input.by === 'day' ? 'asc' : input.by === 'broadcast' ? 'desc' : 'asc' },
    };
    return runAnalyticsQuery({ tx: ctx.tx, events: ctx.services.events, workspaceId: ctx.principal.workspaceId }, query);
  },
});

const JourneyId = z.string().regex(/^jrn_[0-9a-f]{32}$/, 'A journey id (jrn_…)');

/** The funnel's four headline totals, each null when it is withheld. */
export interface JourneyFunnelTotals {
  entered: number | null;
  goalReached: number | null;
  completed: number | null;
  exited: number | null;
}

export interface JourneyFunnelStep {
  step: string;
  reached: number | null;
}

/** One node of the published topology, with the outgoing edges the runtime walks. */
export interface JourneyFunnelNode {
  id: string;
  kind: string;
  /** Fork targets, or the single following node; empty for an exit and for a node with no edge. */
  children: string[];
}

type TotalName = 'entered' | 'goalReached' | 'completed' | 'exited';

/**
 * The funnel's k rule (#908, #917 review rounds 2-5).
 *
 * Step rows are read RAW from the measure layer (no row suppression) so this report can apply a rule
 * that is sound by construction. Let P be the rows that are below k (primary hidden rows). For every
 * h in P and every parent p of h in the published graph, hide every proper descendant of p: all of
 * p's children and everything below them, through forks, merges and loops (a visited set terminates
 * cycles; p itself stays visible). If a primary row has no parent — an entry/trigger step — hide
 * every step row. Nothing else is hidden, and rows hidden by this rule never trigger it again.
 *
 * Why it is sound: every number the response still prints is unchanged if one participant who passed
 * through p is moved between branches below p, or from waiting at p into h's branch, because every
 * row that changes lies below p and is hidden and the headlines are withheld whenever a step is
 * hidden. Two populations with different counts at h therefore produce the same visible response.
 *
 * Headlines are never modelled: whenever any step row is hidden, every headline total is withheld
 * (a headline minus the visible steps could name the hidden count); a positive headline below k is
 * withheld regardless. Without a published topology there is no graph, so a below-k step hides every
 * step row and every headline. Drop-off and rate with a hidden operand are null in the handler.
 * Over-suppression is deliberate.
 */
export function planJourneyFunnelSuppression(opts: {
  totals: JourneyFunnelTotals;
  steps: readonly JourneyFunnelStep[];
  /** The published topology, or null when only event order is known. */
  topology: readonly JourneyFunnelNode[] | null;
  k?: number;
}): {
  totals: JourneyFunnelTotals;
  steps: JourneyFunnelStep[];
  withheld: string[];
  hiddenSteps: number;
  /** The parents whose whole subtree was hidden, for the note. */
  hiddenParents: string[];
  /** True when every step row was hidden (no graph, or a hidden step with no parent). */
  allStepsHidden: boolean;
} {
  const k = opts.k ?? K;
  const names: readonly TotalName[] = ['entered', 'goalReached', 'completed', 'exited'];
  const initial = { ...opts.totals };
  const totals = { ...opts.totals };
  const steps = opts.steps.map((step) => ({ ...step }));
  const present = new Set(steps.map((step) => step.step));

  // A row with reached 0 is not below k; a null input row is already hidden.
  const primary = steps.filter((step) => step.reached === null || (step.reached > 0 && step.reached < k)).map((step) => step.step);
  const hidden = new Set<string>();
  const hiddenParents = new Set<string>();
  let allStepsHidden = false;

  if (primary.length) {
    if (!opts.topology) {
      allStepsHidden = true;
    } else {
      const childrenOf = new Map(opts.topology.map((node) => [node.id, node.children]));
      for (const step of primary) {
        const parents = opts.topology.filter((node) => node.children.includes(step)).map((node) => node.id);
        if (!parents.length) {
          // An entry/trigger step has no parent to scope the change to.
          allStepsHidden = true;
          break;
        }
        for (const parent of parents) {
          hiddenParents.add(parent);
          // Every proper descendant of the parent; the parent itself seeds the visited set so a
          // loop back to it does not hide it.
          const seen = new Set([parent]);
          const queue = [...(childrenOf.get(parent) ?? [])];
          while (queue.length) {
            const id = queue.shift()!;
            if (seen.has(id)) continue;
            seen.add(id);
            if (present.has(id)) hidden.add(id);
            queue.push(...(childrenOf.get(id) ?? []));
          }
        }
      }
    }
  }
  if (allStepsHidden) for (const step of steps) hidden.add(step.step);

  let hiddenSteps = 0;
  for (const step of steps) {
    if (!hidden.has(step.step)) continue;
    if (step.reached !== null) hiddenSteps += 1;
    step.reached = null;
  }

  // A positive headline below k is a small group of its own; zero is not invented as one.
  for (const name of names) {
    const value = totals[name];
    if (value !== null && value > 0 && value < k) totals[name] = null;
  }
  // Any hidden step could be recovered as a headline minus the visible steps, so every headline goes.
  if (steps.some((step) => step.reached === null)) for (const name of names) totals[name] = null;

  // Drop a parent that is itself inside another hidden parent's subtree: the note names the roots,
  // and a second primary row below one only adds a redundant name.
  const descendantsOf = (root: string): Set<string> => {
    const seen = new Set<string>([root]);
    const queue = [...(opts.topology?.find((node) => node.id === root)?.children ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(opts.topology?.find((node) => node.id === id)?.children ?? []));
    }
    return seen;
  };
  const roots = [...hiddenParents].filter(
    (parent) => ![...hiddenParents].some((other) => other !== parent && descendantsOf(other).has(parent)),
  );
  const withheld = names.filter((name) => totals[name] === null && initial[name] !== null);
  return { totals, steps, withheld, hiddenSteps, hiddenParents: roots.sort(), allStepsHidden };
}

/**
 * Kinds that must name their edges: unlike the others, they never fall through to the next node.
 * Together with the edge fields they decide the branch rule: any node with more than one `next`
 * edge forks, which is how `branch`, `split`, `decision` and `aiDecide` always appear, and how
 * `waitEvent`, `waitUntil`, `goal` and `action` appear when they name a timeout or error exit. A
 * single saved edge sends both outcomes down that edge, so it is still one step.
 */
const NO_IMPLICIT_NEXT = new Set(['branch', 'split', 'decision', 'aiDecide']);

interface JourneyWalk {
  /** Node ids in breadth-first order from the trigger, then any node the walk cannot reach. */
  order: string[];
  /** True only for a straight line that covers every published node exactly once. */
  linear: boolean;
  /** Every node with the outgoing edges the runtime walks, in the same order. */
  edges: JourneyFunnelNode[];
}

/**
 * The published journey's walk (#591). Reach is breadth-first from the trigger, so each node
 * appears once and at its earliest position. A linear journey is one chain the runtime can walk:
 * every node has at most one outgoing step, the walk covers every node, no node is visited twice
 * and no step reconverges. Branch, split, decision, AI-decision and two-edge wait/action nodes
 * fork the walk, as does any node with more than one saved edge.
 */
function publishedWalk(content: unknown): JourneyWalk | null {
  const parsed = artifactTypes.journey.content.safeParse(content);
  if (!parsed.success) return null;
  const nodes = parsed.data.nodes;
  const byId = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const trigger = nodes.find((node) => node.kind === 'trigger');
  if (!trigger) return null;

  let forks = false;
  const outgoing = (id: string): string[] => {
    const found = byId.get(id);
    if (!found) return [];
    const { node, index } = found;
    // The runtime always ends an exit node, whatever its saved edge fields say.
    if (node.kind === 'exit') return [];
    const next = node.next ?? [];
    if (next.length > 1) {
      forks = true;
      return next.map((edge) => edge.to);
    }
    if (next.length === 1) return [next[0]!.to];
    // An omitted `next` continues with the following saved node, exactly as the runtime does.
    if (NO_IMPLICIT_NEXT.has(node.kind)) return [];
    const following = nodes[index + 1]?.id;
    return following ? [following] : [];
  };

  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [trigger.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const to of outgoing(id)) if (!seen.has(to)) queue.push(to);
  }
  const reachable = order.length;
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    order.push(node.id);
  }

  const linear =
    !forks &&
    reachable === nodes.length &&
    order.every((id, index) => {
      const out = outgoing(id);
      return index === order.length - 1 ? out.length === 0 : out.length === 1 && out[0] === order[index + 1];
    });
  const edges = order.map((id) => ({ id, kind: byId.get(id)!.node.kind, children: outgoing(id) }));
  return { order, linear, edges };
}

interface PublishedJourney extends JourneyWalk {
  version: number;
}

/** The published journey's version and walk, or null when it has no published topology. */
async function publishedJourney(tx: Tx, workspaceId: string, journeyId: string): Promise<PublishedJourney | null> {
  const [artifact] = await tx
    .select({ publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, journeyId), eq(schema.artifacts.type, 'journey')));
  if (!artifact?.publishedVersion) return null;
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, workspaceId),
        eq(schema.artifactVersions.artifactId, journeyId),
        eq(schema.artifactVersions.number, artifact.publishedVersion),
      ),
    );
  if (!row) return null;
  const walk = publishedWalk(row.content);
  return {
    version: artifact.publishedVersion,
    order: walk?.order ?? [],
    linear: walk?.linear ?? false,
    edges: walk?.edges ?? [],
  };
}

export const analyticsJourneyFunnel = defineCommand({
  name: 'analytics.journeyFunnel',
  title: 'Journey funnel',
  description:
    'One journey over a period: entered → each step reached → goal reached → completed or exited. Drop-off and drop-off rate are returned only for a straight-line published journey (no branch, split, alternative wait/action exit, loop or reconvergence) whose counts are non-increasing along the walk; any other topology, or a later step that outnumbers an earlier one because people joined mid-journey (for example after a version migration), reports reach per node in breadth-first order with null drop-off. A drop-off or rate that would be computed from a withheld count is null. Counts use only the published version when the journey has one. Step counts come from journey_events. A step row below k=5 hides the whole subtree under its parent in the published graph — every descendant, through forks, merges and loops — so moving one participant between branches under that parent cannot change anything the response still shows. A below-k entry step, or any below-k step when no published version is selected, hides every step row. Headlines are not modelled: if any step row is hidden, every headline total (entered, goalReached, completed, exited) is withheld (null), because a headline minus the visible steps could name the hidden count, and a positive headline below k is withheld regardless. A drop-off or rate with a hidden operand is null. A note names the hidden subtree’s parent, or says every step row was hidden.',

  input: z.object({
    journeyId: JourneyId,
    from: isoDateTime('from'),
    to: isoDateTime('to'),
  }),
  output: z.object({
    journeyId: z.string(),
    basis: z
      .enum(['published', 'reach'])
      .describe(
        'published: a straight-line published topology with non-increasing counts, so drop-off is a chain; reach: no straight-line published topology (none, branching, loop or reconvergence) or counts that rise along the walk (people joining mid-journey, for example after a migration), so steps are reach without a chain',
      ),
    entered: z
      .number()
      .nullable()
      .describe('People who entered in the period; null when the count is below k=5 or a hidden step could be derived from it'),
    goalReached: z.number().nullable().describe('People who reached the journey goal; null when withheld by the k rule'),
    completed: z.number().nullable().describe('People who completed; null when withheld by the k rule'),
    exited: z.number().nullable().describe('People who exited; null when withheld by the k rule'),
    steps: z.array(
      z.object({
        step: z.string(),
        reached: z.number().nullable().describe('People who reached this step; null when suppressed or hidden as a complement'),
        dropOff: z.number().nullable().describe('People lost against the previous visible step; null when a count it needs is withheld'),
        dropOffRate: z.number().nullable().describe('dropOff divided by the previous step; null when a count it needs is withheld'),
      }),
    ),
    meta: analyticsMeta,
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const deps = { tx: ctx.tx, events: ctx.services.events, workspaceId: ctx.principal.workspaceId };
    const filters = { journey: [input.journeyId] };
    // Journey events record the version that produced them. When a published version exists,
    // every count describes that version alone (#591); without one there is nothing to select.
    const published = await publishedJourney(ctx.tx, ctx.principal.workspaceId, input.journeyId);
    const versionScope = published ? { journeyVersion: published.version } : {};
    const totals = await runAnalyticsQuery(deps, {
      measures: ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited'],
      dimensions: [],
      from: input.from,
      to: input.to,
      filters,
      limit: 1,
      ...versionScope,
    });
    const stepsResult = await runAnalyticsQuery(deps, {
      measures: ['journey.step_reached'],
      dimensions: ['journey_step'],
      from: input.from,
      to: input.to,
      filters,
      limit: 5000,
      order: { by: 'journey_step', dir: 'asc' },
      // Raw rows: this report applies its own subtree rule below (#917 review round 5).
      suppress: false,
      ...versionScope,
    });

    const total = (measure: string): number | null => {
      const index = totals.columns.findIndex((c) => c.name === measure);
      const value = totals.rows[0]?.[index];
      return typeof value === 'number' ? value : null;
    };
    const reachedByStep = new Map(stepsResult.rows.map((row) => [String(row[0]), typeof row[1] === 'number' ? row[1] : null] as const));
    // A published topology defines both the steps and their order; without one the event order
    // is the only order there is, and it stays cross-version reach.
    const stepIds = published ? published.order : stepsResult.rows.map((row) => String(row[0]));
    const reachedSteps = stepIds.flatMap((step) => {
      if (!reachedByStep.has(step)) return [];
      return [{ step, reached: reachedByStep.get(step) ?? null }];
    });
    // #908: the totals are an undimensioned query the measure layer never suppressed, while the
    // step rows beside them were. Apply the funnel's k rule before anything is derived from them.
    const funnel = planJourneyFunnelSuppression({
      totals: {
        entered: total('journey.entered'),
        goalReached: total('journey.goal_reached'),
        completed: total('journey.completed'),
        exited: total('journey.exited'),
      },
      steps: reachedSteps,
      topology: published ? published.edges : null,
      k: K,
    });
    const entered = funnel.totals.entered;
    // A drop-off chain needs one straight line: no fork, loop or reconvergence. It also needs its
    // counts to fall along the walk. Migration moves a participant to the new version without a new
    // entry (journeys.migrate), so a later step can outnumber the entry step; a negative drop-off is
    // never clamped to zero, and the report falls back to reach instead (#591).
    let previous: number | null = entered;
    let monotone = true;
    for (const { reached } of funnel.steps) {
      if (reached === null) continue;
      if (previous !== null && reached > previous) monotone = false;
      previous = reached;
    }
    const chain = published?.linear === true && monotone;
    let previousReach: number | null = entered;
    const steps = funnel.steps.map(({ step, reached }) => {
      const dropOff = chain && previousReach !== null && reached !== null ? previousReach - reached : null;
      const dropOffRate = dropOff === null || previousReach === null || previousReach === 0 ? null : dropOff / previousReach;
      // A hidden step breaks the chain: the next step has no visible predecessor to compare with,
      // so its drop-off is null rather than a comparison across a withheld count.
      previousReach = reached;
      return { step, reached, dropOff, dropOffRate };
    });

    const suppressionNotes: string[] = [];
    if (funnel.allStepsHidden)
      suppressionNotes.push(
        published
          ? `Every step row is hidden because a step below k=${K} has no parent in the published graph.`
          : `No published version is selected, and a step has fewer than k=${K} people, so every step row is hidden.`,
      );
    else if (funnel.hiddenParents.length > 0)
      suppressionNotes.push(`Steps after ${funnel.hiddenParents.join(', ')} are hidden because one of them has fewer than k=${K} people.`);
    if (steps.some((step) => step.reached === null))
      suppressionNotes.push(
        'All totals are withheld because a step row is hidden: a headline minus the visible steps could name the hidden count.',
      );
    else if (funnel.withheld.length > 0)
      suppressionNotes.push(`Totals withheld because they are positive counts below k=${K}: ${funnel.withheld.join(', ')}.`);

    const notes = [
      ...new Set([
        ...stepsResult.meta.notes,
        ...suppressionNotes,
        published?.linear && !monotone
          ? `People joined the published journey v${published.version} after a later step (for example after a version migration), so reach is not a drop-off chain. Steps are reach per node in breadth-first order from the entry, and only entries recorded for v${published.version} are counted.`
          : published?.linear
            ? `Steps follow the published journey v${published.version}’s linear topology; drop-off compares each step with the previous visible one, and only entries recorded for v${published.version} are counted.`
            : published
              ? `The published journey v${published.version} is not a straight line (it branches, splits, waits with alternative exits or loops), so there is no sequential drop-off. Steps are reach per node in breadth-first order from the entry, and only entries recorded for v${published.version} are counted. Drop-off is shown only for linear journeys.`
              : 'No published version is selected, so steps are cross-version reach without a drop-off chain.',
      ]),
    ];
    return {
      journeyId: input.journeyId,
      basis: chain ? ('published' as const) : ('reach' as const),
      entered,
      goalReached: funnel.totals.goalReached,
      completed: funnel.totals.completed,
      exited: funnel.totals.exited,
      steps,
      meta: {
        ...stepsResult.meta,
        suppressed: steps.filter((step) => step.reached === null).length + funnel.withheld.length,
        notes,
      },
    };
  },
});

export const analyticsReports = [analyticsEmailPerformance, analyticsJourneyFunnel] as const;
