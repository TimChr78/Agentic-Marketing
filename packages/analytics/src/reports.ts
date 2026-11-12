import { artifactTypes } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { analyticsMeta, analyticsResult, type QueryInput, runAnalyticsQuery } from './query';

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
  return { order, linear };
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
  return { version: artifact.publishedVersion, order: walk?.order ?? [], linear: walk?.linear ?? false };
}

export const analyticsJourneyFunnel = defineCommand({
  name: 'analytics.journeyFunnel',
  title: 'Journey funnel',
  description:
    'One journey over a period: entered → each step reached → goal reached → completed or exited. Drop-off and drop-off rate are returned only for a straight-line published journey (no branch, split, alternative wait/action exit, loop or reconvergence) and compare consecutive steps; any other topology reports reach per node in breadth-first order with null drop-off. Counts use only the published version when the journey has one. Step counts come from journey_events; groups smaller than k=5 are suppressed and counted in meta.suppressed.',
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
        'published: a straight-line published topology, so drop-off is a chain; reach: no straight-line published topology (none, branching, loop or reconvergence), so steps are reach without a chain',
      ),
    entered: z.number(),
    goalReached: z.number(),
    completed: z.number(),
    exited: z.number(),
    steps: z.array(
      z.object({
        step: z.string(),
        reached: z.number().nullable(),
        dropOff: z.number().nullable(),
        dropOffRate: z.number().nullable(),
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
      ...versionScope,
    });

    const total = (measure: string) => {
      const index = totals.columns.findIndex((c) => c.name === measure);
      const value = totals.rows[0]?.[index];
      return typeof value === 'number' ? value : 0;
    };
    const entered = total('journey.entered');
    const reachedByStep = new Map(stepsResult.rows.map((row) => [String(row[0]), typeof row[1] === 'number' ? row[1] : null] as const));
    // A published topology defines both the steps and their order; without one the event order
    // is the only order there is, and it stays cross-version reach.
    const stepIds = published ? published.order : stepsResult.rows.map((row) => String(row[0]));
    let previous: number | null = entered;
    const steps = stepIds.flatMap((step) => {
      if (!reachedByStep.has(step)) return [];
      const reached = reachedByStep.get(step) ?? null;
      // A drop-off chain needs one straight line: no fork, loop or reconvergence. It never goes
      // below zero, even when events for a later step arrive out of order.
      const dropOff = published?.linear && previous !== null && reached !== null ? Math.max(0, previous - reached) : null;
      const dropOffRate = dropOff === null || previous === null || previous === 0 ? null : dropOff / previous;
      previous = reached;
      return [{ step, reached, dropOff, dropOffRate }];
    });

    const notes = [
      ...new Set([
        ...stepsResult.meta.notes,
        published?.linear
          ? `Steps follow the published journey v${published.version}’s linear topology; drop-off compares each step with the previous one, and only entries recorded for v${published.version} are counted.`
          : published
            ? `The published journey v${published.version} is not a straight line (it branches, splits, waits with alternative exits or loops), so there is no sequential drop-off. Steps are reach per node in breadth-first order from the entry, and only entries recorded for v${published.version} are counted. Drop-off is shown only for linear journeys.`
            : 'No published version is selected, so steps are cross-version reach without a drop-off chain.',
      ]),
    ];
    return {
      journeyId: input.journeyId,
      basis: published?.linear ? ('published' as const) : ('reach' as const),
      entered,
      goalReached: total('journey.goal_reached'),
      completed: total('journey.completed'),
      exited: total('journey.exited'),
      steps,
      meta: { ...stepsResult.meta, suppressed: totals.meta.suppressed + stepsResult.meta.suppressed, notes },
    };
  },
});

export const analyticsReports = [analyticsEmailPerformance, analyticsJourneyFunnel] as const;
