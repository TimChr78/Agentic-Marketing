import { defineCommand } from '@agentic-marketing/commands';
import { isoDateTime } from '@agentic-marketing/core';
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
    let previous: number | null = entered;
    const steps = stepsResult.rows.map((row) => {
      const step = String(row[0]);
      const value = row[1];
      const reached = typeof value === 'number' ? value : null;
      const dropOff = previous === null || reached === null ? null : previous - reached;
      const dropOffRate = dropOff === null || previous === null || previous === 0 ? null : dropOff / previous;
      previous = reached;
      return { step, reached, dropOff, dropOffRate };
    });

    const notes = [
      ...new Set([...stepsResult.meta.notes, 'Steps are counted from journey_events; drop-off compares each step with the previous one.']),
    ];
    return {
      journeyId: input.journeyId,
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
