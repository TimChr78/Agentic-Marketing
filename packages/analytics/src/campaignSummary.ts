import { publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { computeJourneyHoldout, type JourneyHoldoutResult } from '@agentic-marketing/journeys';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type CampaignMember, type CampaignRecord, goalEventsFor, loadCampaignRecord } from './campaign';
import { type AnalyticsResult, analyticsMeta, runAnalyticsQuery } from './query';

// The campaign summary (#66) is a named report over the campaign measures and the existing
// e-mail measures. It keeps the raw runs out of the UI: the funnel, per-member rows and journey
// holdouts all come from the same tenant-scoped metric layer.

const CampaignId = z.string().regex(/^cmp_[0-9a-f]{32}$/, 'A campaign id (cmp_…)');
const K = 5;

interface Deps {
  tx: Tx;
  events: EventStore;
  workspaceId: string;
}

const goalSchema = z.object({
  kind: z.enum(['conversion', 'revenue', 'engagement', 'signups', 'custom']),
  event: z.string().nullable(),
  target: z.number().nullable(),
  attributionDays: z.number().int(),
});

const readinessSchema = z.object({
  published: z.boolean(),
  membersPublished: z.boolean(),
  sendingMembers: z.number().int(),
  publishedSendingMembers: z.number().int(),
  sendingMembersScheduled: z.boolean(),
});

const currencyAmount = z.object({ currency: z.string(), amount: z.number() });

const headlineSchema = z.object({
  recipients: z.number().int(),
  delivered: z.number().int(),
  clickers: z.number().int(),
  unsubscribers: z.number().int(),
  complaintRate: z.number().nullable(),
  unsubscribeRate: z.number().nullable(),
  converters: z.number().int(),
  conversionRate: z.number().nullable(),
  revenue: z.array(currencyAmount),
  revenuePerRecipient: z.array(currencyAmount),
  targetProgress: z
    .number()
    .nullable()
    .describe('Progress against goal.target; null when there is no target or currencies cannot be compared'),
});

const funnelStep = z.object({
  step: z.enum(['recipients', 'delivered', 'clicked', 'converted']),
  count: z.number().int(),
  stepRate: z.number().nullable().describe('Count divided by the previous step'),
  shareOfRecipients: z.number().nullable(),
});

const memberRow = z.object({
  artifactId: z.string(),
  name: z.string(),
  type: z.string(),
  role: z.enum(['primary', 'follow_up', 'content']),
  sent: z.number().int(),
  delivered: z.number().int(),
  clickRate: z.number().nullable(),
  unsubscribeRate: z.number().nullable(),
  converters: z.number().int(),
});

const holdoutSchema = z.object({
  journeyId: z.string(),
  name: z.string(),
  controlGroup: z.object({ percent: z.number(), minSampleSize: z.number(), hashVersion: z.string() }),
  control: z.object({
    entered: z.number(),
    converted: z.number(),
    unsubscribed: z.number(),
    conversionRate: z.number(),
    unsubscribeRate: z.number(),
  }),
  treatment: z.object({
    entered: z.number(),
    converted: z.number(),
    unsubscribed: z.number(),
    conversionRate: z.number(),
    unsubscribeRate: z.number(),
  }),
  absoluteLift: z.number(),
  relativeLift: z.number().nullable(),
  ci95: z.tuple([z.number(), z.number()]).nullable(),
  minSampleSizeMet: z.boolean(),
  verdict: z.enum(['not_enough_data', 'no_clear_difference', 'treatment_better', 'treatment_worse']),
  note: z.string(),
});

const campaignSummaryOutput = z.union([
  z.object({
    campaignId: z.string(),
    name: z.string(),
    state: z.literal('not_started'),
    goal: goalSchema,
    readiness: readinessSchema,
    meta: analyticsMeta,
  }),
  z.object({
    campaignId: z.string(),
    name: z.string(),
    state: z.literal('measured'),
    goal: goalSchema,
    headline: headlineSchema,
    funnel: z.array(funnelStep),
    members: z.array(memberRow),
    holdouts: z.array(holdoutSchema),
    meta: analyticsMeta,
  }),
]);

async function workspaceTimeZone(tx: Tx, workspaceId: string): Promise<string> {
  const [w] = await tx
    .select({ timeZone: schema.workspaces.timeZone })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return w?.timeZone ?? 'UTC';
}

const columnIndex = (result: AnalyticsResult, name: string) => result.columns.findIndex((c) => c.name === name);
const cell = (result: AnalyticsResult, name: string) => {
  const index = columnIndex(result, name);
  const value = index >= 0 ? result.rows[0]?.[index] : undefined;
  return typeof value === 'number' ? value : 0;
};
const sendingMembers = (record: CampaignRecord): CampaignMember[] =>
  record.members.filter((m) => m.type === 'broadcast' || m.type === 'journey');

async function hasSent(deps: Deps, memberIds: string[]): Promise<boolean> {
  if (!memberIds.length) return false;
  const result = await deps.events.client.query({
    query: `SELECT 1 FROM message_events FINAL
            WHERE workspace_id = {ws:UUID} AND journey_id IN {members:Array(String)}
              AND type IN ('sent', 'delivered') LIMIT 1`,
    query_params: { ws: deps.workspaceId, members: memberIds },
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10, max_result_rows: 1 } as never,
  });
  return (await result.json<unknown>()).length > 0;
}

async function readiness(tx: Tx, record: CampaignRecord): Promise<z.infer<typeof readinessSchema>> {
  const sending = sendingMembers(record);
  const broadcastIds = sending.filter((m) => m.type === 'broadcast').map((m) => m.artifactId);
  const runs = broadcastIds.length
    ? await tx
        .select({ broadcastId: schema.broadcastRuns.broadcastId })
        .from(schema.broadcastRuns)
        .where(inArray(schema.broadcastRuns.broadcastId, broadcastIds))
    : [];
  const scheduled = new Set(runs.map((r) => r.broadcastId));
  const scheduledJourneys = sending.filter((m) => m.type === 'journey' && m.published).length;
  const publishedSending = sending.filter((m) => m.published).length;
  return {
    published: record.published,
    membersPublished: sending.length > 0 && publishedSending === sending.length,
    sendingMembers: sending.length,
    publishedSendingMembers: publishedSending,
    sendingMembersScheduled: scheduled.size > 0 || scheduledJourneys > 0,
  };
}

interface MemberBreakdown {
  artifactId: string;
  sent: number;
  delivered: number;
  clicked: number;
  unsubscribed: number;
  converters: number;
}

/** One row per sending member: message performance and attributed converters. */
async function memberBreakdown(deps: Deps, memberIds: string[], from: string, to: string, goalEvents: string[], attributionDays: number) {
  const result = await deps.events.client.query({
    query: `WITH
      first AS (
        SELECT journey_id AS member_id, profile_id, min(at) AS first_at
        FROM message_events FINAL
        WHERE workspace_id = {ws:UUID} AND journey_id IN {members:Array(String)}
          AND at >= {from:DateTime64(3, 'UTC')} AND at <= {to:DateTime64(3, 'UTC')}
          AND type IN ('sent', 'delivered') AND profile_id != ''
        GROUP BY member_id, profile_id
      ),
      sent AS (
        SELECT journey_id AS member_id,
          uniqExactIf(profile_id, type = 'sent') AS sent,
          uniqExactIf(profile_id, type = 'delivered') AS delivered,
          uniqExactIf(profile_id, type = 'clicked') AS clicked,
          uniqExactIf(profile_id, type = 'unsubscribed') AS unsubscribed
        FROM message_events FINAL
        WHERE workspace_id = {ws:UUID} AND journey_id IN {members:Array(String)}
          AND at >= {from:DateTime64(3, 'UTC')} AND at <= {to:DateTime64(3, 'UTC')}
        GROUP BY member_id
      ),
      conv AS (
        SELECT f.member_id, uniqExact(f.profile_id) AS converters
        FROM events e FINAL
        INNER JOIN first f ON f.profile_id = e.profile_id
        WHERE e.workspace_id = {ws:UUID}
          AND e.name IN {goal_events:Array(String)}
          AND e.timestamp >= f.first_at
          AND e.timestamp <= addDays(f.first_at, {attribution_days:Int32})
        GROUP BY f.member_id
      )
      SELECT s.member_id, s.sent, s.delivered, s.clicked, s.unsubscribed, ifNull(c.converters, 0) AS converters
      FROM sent s LEFT JOIN conv c ON c.member_id = s.member_id`,
    query_params: {
      ws: deps.workspaceId,
      members: memberIds,
      from: from.replace('Z', ''),
      to: to.replace('Z', ''),
      goal_events: goalEvents,
      attribution_days: attributionDays,
    },
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10, max_result_rows: 500 } as never,
  });
  const rows = await result.json<Record<string, unknown>>();
  return new Map<string, MemberBreakdown>(
    rows.map((r) => [
      String(r.member_id),
      {
        artifactId: String(r.member_id),
        sent: Number(r.sent ?? 0),
        delivered: Number(r.delivered ?? 0),
        clicked: Number(r.clicked ?? 0),
        unsubscribed: Number(r.unsubscribed ?? 0),
        converters: Number(r.converters ?? 0),
      },
    ]),
  );
}

async function holdoutResults(deps: Deps, record: CampaignRecord, from: string, to: string) {
  const out: (JourneyHoldoutResult & { name: string })[] = [];
  for (const member of sendingMembers(record)) {
    if (member.type !== 'journey' || !member.published) continue;
    try {
      const result = await computeJourneyHoldout(deps, member.artifactId, { from, to });
      out.push({ ...result, name: member.name });
    } catch (error) {
      // A journey without a control group (or without a publish) has no uplift to report; the
      // summary still shows its message performance.
      if (error instanceof AppError && (error.code === 'not_found' || error.code === 'invalid_input')) continue;
      throw error;
    }
  }
  return out;
}

export const analyticsCampaignSummary = defineCommand({
  name: 'analytics.campaignSummary',
  title: 'Campaign evaluation',
  description:
    'One campaign’s goal and attribution: recipients, delivered, clickers, unsubscribers, complaint and unsubscribe rates, converters, conversion rate, revenue per currency and per recipient, progress towards the target when set, and the recipients → delivered → clicked → converted funnel. Includes a row per sending member (broadcast or journey) and the holdout result for journey members with a control group. A campaign that has not sent yet returns state "not_started" with readiness instead of zeros.',
  input: z.object({
    campaignId: CampaignId,
    from: isoDateTime('from').optional().describe('Count sends at or after this time; defaults to the campaign start'),
    to: isoDateTime('to').optional().describe('Count sends at or before this time; defaults to now'),
  }),
  output: campaignSummaryOutput,
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.campaignId,
  handler: async (input, ctx) => {
    const deps: Deps = { tx: ctx.tx, events: ctx.services.events, workspaceId: ctx.principal.workspaceId };
    const record = await loadCampaignRecord(ctx.tx, input.campaignId);
    const timeZone = await workspaceTimeZone(ctx.tx, deps.workspaceId);
    const now = new Date().toISOString();
    const from = input.from ?? record.startsAt ?? '2000-01-01T00:00:00.000Z';
    const to = input.to ?? now;
    const ready = await readiness(ctx.tx, record);

    const sending = sendingMembers(record);
    const memberIds = sending.map((m) => m.artifactId);
    const baseMeta = {
      timeZone,
      currency: null as string | null,
      from,
      to,
      freshness: null as string | null,
      suppressed: 0,
      k: K,
      notes: [
        `Campaign conversions are people who got a campaign message and converted within ${record.goal.attributionDays} days of their first campaign message (first touch).`,
      ],
    };

    if (!record.published || !sending.length || !(await hasSent(deps, memberIds))) {
      return {
        campaignId: record.id,
        name: record.name,
        state: 'not_started' as const,
        goal: record.goal,
        readiness: ready,
        meta: baseMeta,
      };
    }

    const queryFilters = { campaign: [record.id] };
    const totals = await runAnalyticsQuery(deps, {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.conversion_rate'],
      dimensions: [],
      from,
      to,
      filters: queryFilters,
      limit: 1,
    });
    const email = await runAnalyticsQuery(deps, {
      measures: ['email.sent', 'email.delivered', 'email.clicked', 'email.unsubscribed', 'email.complained'],
      dimensions: [],
      from,
      to,
      filters: queryFilters,
      limit: 1,
    });
    const revenue = await runAnalyticsQuery(deps, {
      measures: ['campaign.revenue'],
      dimensions: [],
      from,
      to,
      filters: queryFilters,
      limit: 5000,
    });

    const recipients = cell(totals, 'campaign.recipients');
    const converters = cell(totals, 'campaign.converters');
    const delivered = cell(email, 'email.delivered');
    const clickers = cell(email, 'email.clicked');
    const unsubscribers = cell(email, 'email.unsubscribed');
    const complained = cell(email, 'email.complained');
    const conversionRate = recipients ? converters / recipients : null;
    const currencyIndex = columnIndex(revenue, 'currency');
    const revenueIndex = columnIndex(revenue, 'campaign.revenue');
    const revenueRows =
      currencyIndex >= 0 && revenueIndex >= 0
        ? revenue.rows.flatMap((row) => {
            const currency = row[currencyIndex];
            const amount = row[revenueIndex];
            return typeof currency === 'string' && typeof amount === 'number' ? [{ currency, amount }] : [];
          })
        : [];
    const revenuePerRecipient = revenueRows.map((r) => ({ currency: r.currency, amount: recipients ? r.amount / recipients : 0 }));

    let targetProgress: number | null = null;
    if (record.goal.target && record.goal.target > 0) {
      if (record.goal.kind === 'revenue' && revenueRows.length === 1) targetProgress = revenueRows[0].amount / record.goal.target;
      else if (record.goal.kind !== 'revenue') targetProgress = converters / record.goal.target;
    }

    // Revenue goals follow the conversion map, exactly like campaign.converters does.
    const conversionMap = await publishedSingleton(ctx.tx, 'conversion_map');
    const goalEvents = goalEventsFor(
      record.goal,
      (conversionMap?.rules ?? []).map((r) => r.event),
    );
    const breakdown = await memberBreakdown(deps, memberIds, from, to, goalEvents, record.goal.attributionDays);
    const members = sending.map((m) => {
      const row = breakdown.get(m.artifactId);
      const sent = row?.sent ?? 0;
      const memberDelivered = row?.delivered ?? 0;
      return {
        artifactId: m.artifactId,
        name: m.name,
        type: m.type,
        role: m.role,
        sent,
        delivered: memberDelivered,
        clickRate: memberDelivered ? (row?.clicked ?? 0) / memberDelivered : null,
        unsubscribeRate: memberDelivered ? (row?.unsubscribed ?? 0) / memberDelivered : null,
        converters: row?.converters ?? 0,
      };
    });

    const funnel = [
      { step: 'recipients' as const, count: recipients, stepRate: null, shareOfRecipients: recipients ? 1 : null },
      {
        step: 'delivered' as const,
        count: delivered,
        stepRate: recipients ? delivered / recipients : null,
        shareOfRecipients: recipients ? delivered / recipients : null,
      },
      {
        step: 'clicked' as const,
        count: clickers,
        stepRate: delivered ? clickers / delivered : null,
        shareOfRecipients: recipients ? clickers / recipients : null,
      },
      {
        step: 'converted' as const,
        count: converters,
        stepRate: clickers ? converters / clickers : null,
        shareOfRecipients: recipients ? converters / recipients : null,
      },
    ];

    const holdouts = await holdoutResults(deps, record, from, to);
    const notes = [...new Set([...totals.meta.notes, ...email.meta.notes, ...revenue.meta.notes, ...baseMeta.notes])];

    return {
      campaignId: record.id,
      name: record.name,
      state: 'measured' as const,
      goal: record.goal,
      headline: {
        recipients,
        delivered,
        clickers,
        unsubscribers,
        complaintRate: delivered ? complained / delivered : null,
        unsubscribeRate: delivered ? unsubscribers / delivered : null,
        converters,
        conversionRate,
        revenue: revenueRows,
        revenuePerRecipient,
        targetProgress,
      },
      funnel,
      members,
      holdouts,
      meta: {
        timeZone,
        currency: revenueRows.length === 1 ? revenueRows[0].currency : null,
        from,
        to,
        freshness: email.meta.freshness ?? totals.meta.freshness,
        suppressed: totals.meta.suppressed + email.meta.suppressed + revenue.meta.suppressed,
        k: K,
        notes,
      },
    };
  },
});
