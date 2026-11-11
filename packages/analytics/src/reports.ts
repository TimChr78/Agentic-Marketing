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
 * The order the published topology reaches its nodes: the trigger, then each node's first edge,
 * then any node the walk did not reach in its saved order. This is the same walk the journey
 * report uses, and it is the only order in which a drop-off chain describes one topology (#591).
 */
function publishedNodeOrder(content: unknown): string[] | null {
  const parsed = artifactTypes.journey.content.safeParse(content);
  if (!parsed.success) return null;
  const nodes = parsed.data.nodes;
  const order: string[] = [];
  const seen = new Set<string>();
  let index = nodes.findIndex((node) => node.kind === 'trigger');
  while (index >= 0) {
    const node = nodes[index]!;
    if (seen.has(node.id)) break;
    seen.add(node.id);
    order.push(node.id);
    const to = node.next?.length ? node.next[0]!.to : nodes[index + 1]?.id;
    index = to ? nodes.findIndex((candidate) => candidate.id === to) : -1;
  }
  for (const node of nodes) if (!seen.has(node.id)) order.push(node.id);
  return order;
}

/** The published journey's node order, or null when it has no published topology. */
async function publishedJourneyOrder(tx: Tx, workspaceId: string, journeyId: string): Promise<string[] | null> {
  const [artifact] = await tx
    .select({ publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, journeyId), eq(schema.artifacts.type, 'journey')));
  if (!artifact?.publishedVersion) return null;
  const [version] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, workspaceId),
        eq(schema.artifactVersions.artifactId, journeyId),
        eq(schema.artifactVersions.number, artifact.publishedVersion),
      ),
    );
  return version ? publishedNodeOrder(version.content) : null;
}

export const analyticsJourneyFunnel = defineCommand({
  name: 'analytics.journeyFunnel',
  title: 'Journey funnel',
  description:
    'One journey over a period: entered → each step reached → goal reached → completed or exited, with the drop-off and drop-off rate between steps. Step counts come from journey_events; groups smaller than k=5 are suppressed and counted in meta.suppressed.',
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
        'published: steps follow the live topology and drop-off is a chain; reach: no published topology, so steps are cross-version reach without a chain',
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
    const totals = await runAnalyticsQuery(deps, {
      measures: ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited'],
      dimensions: [],
      from: input.from,
      to: input.to,
      filters,
      limit: 1,
    });
    const stepsResult = await runAnalyticsQuery(deps, {
      measures: ['journey.step_reached'],
      dimensions: ['journey_step'],
      from: input.from,
      to: input.to,
      filters,
      limit: 5000,
      order: { by: 'journey_step', dir: 'asc' },
    });

    const total = (measure: string) => {
      const index = totals.columns.findIndex((c) => c.name === measure);
      const value = totals.rows[0]?.[index];
      return typeof value === 'number' ? value : 0;
    };
    const entered = total('journey.entered');
    const order = await publishedJourneyOrder(ctx.tx, ctx.principal.workspaceId, input.journeyId);
    const reachedByStep = new Map(stepsResult.rows.map((row) => [String(row[0]), typeof row[1] === 'number' ? row[1] : null] as const));
    // With a published topology, walk its node order and leave out ids from other versions. The
    // counts themselves stay cross-version: a node id that survived a republish still aggregates
    // every participant who reached it.
    const stepIds = order ?? stepsResult.rows.map((row) => String(row[0]));
    let previous: number | null = entered;
    const steps = stepIds.flatMap((step) => {
      if (!reachedByStep.has(step)) return [];
      const reached = reachedByStep.get(step) ?? null;
      // Without a published topology there is no honest chain, only per-step reach.
      const dropOff = order && previous !== null && reached !== null ? previous - reached : null;
      const dropOffRate = dropOff === null || previous === null || previous === 0 ? null : dropOff / previous;
      previous = reached;
      return [{ step, reached, dropOff, dropOffRate }];
    });

    const notes = [
      ...new Set([
        ...stepsResult.meta.notes,
        order
          ? 'Steps follow the published journey’s node order; drop-off compares each step with the previous one. Steps that are not in the published version are left out.'
          : 'No published topology is available, so steps are cross-version reach without a drop-off chain.',
      ]),
    ];
    return {
      journeyId: input.journeyId,
      basis: order ? ('published' as const) : ('reach' as const),
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
