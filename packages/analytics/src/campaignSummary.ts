import { planComplementarySuppression, publishedSingleton, suppressHoldout } from '@agentic-marketing/artifacts';
import { campaignIdentityMap, type IdentityMap, identityUnresolvedNote } from '@agentic-marketing/campaigns';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { computeJourneyHoldout } from '@agentic-marketing/journeys';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type CampaignMember, type CampaignRecord, goalEventsFor, loadCampaignRecord } from './campaign';
import { identityQueryParams } from './identityParams';
import { type AnalyticsResult, analyticsMeta, K, MAX_RANGE_DAYS, runAnalyticsQuery } from './query';

// The campaign summary (#66) is a named report over the campaign measures and the existing
// e-mail measures. It keeps the raw runs out of the UI: the funnel, per-member rows and journey
// holdouts all come from the same tenant-scoped metric layer.

const CampaignId = z.string().regex(/^cmp_[0-9a-f]{32}$/, 'A campaign id (cmp_…)');

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

const currencyAmount = z.object({ currency: z.string(), amount: z.number().nullable() });

const headlineSchema = z.object({
  recipients: z
    .number()
    .int()
    .nullable()
    .describe('Distinct people reached by the campaign, on any channel; null when the total was withheld'),
  emailSent: z.number().int().nullable().describe('Distinct people the campaign reached by e-mail; null when the total was withheld'),
  delivered: z.number().int().nullable().describe('Distinct people whose campaign e-mail was delivered; null when the total was withheld'),
  clickers: z.number().int().nullable().describe('Distinct people who clicked; null when the total was withheld'),
  unsubscribers: z.number().int().nullable().describe('Distinct people who unsubscribed; null when the total was withheld'),
  complaintRate: z.number().nullable(),
  unsubscribeRate: z.number().nullable(),
  converters: z.number().int().nullable().describe('Distinct campaign converters; null when the total was withheld'),
  conversionRate: z.number().nullable(),
  revenue: z.array(currencyAmount),
  revenuePerRecipient: z.array(currencyAmount),
  targetProgress: z
    .number()
    .nullable()
    .describe('Progress against goal.target; null when there is no target, a needed total was withheld, or currencies cannot be compared'),
});

const funnelStep = z.object({
  step: z.enum(['recipients', 'delivered', 'clicked', 'converted']),
  count: z.number().int().nullable().describe('People at this step; null when the step total was withheld'),
  stepRate: z.number().nullable().describe('Count divided by the previous step, or null when a needed count was withheld'),
  shareOfRecipients: z.number().nullable(),
});

const memberRow = z.object({
  artifactId: z.string(),
  name: z.string(),
  type: z.string(),
  role: z.enum(['primary', 'follow_up', 'content']),
  sent: z.number().int().nullable().describe('E-mails sent to distinct people; null when the row is suppressed'),
  delivered: z.number().int().nullable().describe('E-mails delivered to distinct people; null when the row is suppressed'),
  clickRate: z.number().nullable(),
  unsubscribeRate: z.number().nullable(),
  converters: z.number().int().nullable().describe('Distinct campaign converters; null when the row is suppressed'),
  suppressed: z
    .boolean()
    .describe(
      'True when the member reached fewer than k people, or is the complementary row hidden so a single small member cannot be derived, so its counts are hidden',
    ),
});

const holdoutArm = z.object({
  entered: z.number().int().nullable().describe('People assigned to the arm; null when the holdout is suppressed'),
  converted: z.number().int().nullable().describe('People in the arm who converted; null when the holdout is suppressed'),
  unsubscribed: z.number().int().nullable().describe('People in the arm who unsubscribed; null when the holdout is suppressed'),
  conversionRate: z.number().nullable().describe('Converted divided by entered; null when the holdout is suppressed'),
  unsubscribeRate: z.number().nullable().describe('Unsubscribed divided by entered; null when the holdout is suppressed'),
});

const holdoutSchema = z.object({
  journeyId: z.string(),
  name: z.string(),
  controlGroup: z.object({ percent: z.number(), minSampleSize: z.number(), hashVersion: z.string() }),
  k: z.number().int().describe('The k-anonymity floor; an arm below it is suppressed'),
  control: holdoutArm,
  treatment: holdoutArm,
  absoluteLift: z.number().nullable().describe('Treatment minus control conversion rate; null when the holdout is suppressed'),
  relativeLift: z.number().nullable(),
  ci95: z.tuple([z.number(), z.number()]).nullable(),
  minSampleSizeMet: z.boolean(),
  verdict: z.enum(['not_enough_data', 'no_clear_difference', 'treatment_better', 'treatment_worse']),
  note: z.string(),
  suppressed: z
    .boolean()
    .describe('True when fewer than k people were in an arm or in the journey member row, so its counts and rates are hidden'),
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

/**
 * When the campaign's members first sent or delivered, or null if they never have. Readiness and
 * the default window follow real sends, not the informational `startsAt`: a journey can send before
 * the planned start, and the start can be edited later (0.14.10 review).
 */
async function firstSendAt(deps: Deps, memberIds: string[]): Promise<string | null> {
  if (!memberIds.length) return null;
  // No FINAL: duplicate rows cannot change a minimum, and FINAL would merge the members' whole
  // history before aggregating.
  const result = await deps.events.client.query({
    query: `SELECT formatDateTime(min(at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first, count() AS n FROM message_events
            WHERE workspace_id = {ws:UUID} AND journey_id IN {members:Array(String)}
              AND type IN ('sent', 'delivered')`,
    query_params: { ws: deps.workspaceId, members: memberIds },
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10 } as never,
  });
  const [row] = await result.json<{ first: string; n: string | number }>();
  if (!row || Number(row.n) === 0) return null;
  // formatDateTime %f gives microseconds; normalise to an ISO string with milliseconds.
  return new Date(Date.parse(row.first.replace(/(\.\d{3})\d*Z$/, '$1Z'))).toISOString();
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
  /** Distinct people the member reached on any channel; the k-anonymity group size. */
  reached: number;
  sent: number;
  delivered: number;
  clicked: number;
  unsubscribed: number;
  converters: number;
}

/** One row per sending member: message performance and attributed converters. */
async function memberBreakdown(
  deps: Deps,
  memberIds: string[],
  from: string,
  to: string,
  goalEvents: string[],
  attributionDays: number,
  identity: IdentityMap,
) {
  // The same chunked transport as the campaign measures: a large map must not exceed ClickHouse's
  // per-field limit just because this surface builds its own query (#590).
  const identityParams = identityQueryParams(identity.overLimit ? [] : identity.pairs);
  const result = await deps.events.client.query({
    query: `WITH
      identity AS (
        SELECT
          arrayElement(${identityParams.keys}, number + 1) AS identity_key,
          arrayElement(${identityParams.profiles}, number + 1) AS profile_id,
          arrayElement(${identityParams.kinds}, number + 1) AS kind
        FROM numbers({identity_count:UInt32})
      ),
      first AS (
        SELECT member_id, profile_id, min(first_at) AS first_at
        FROM (
          SELECT
            m.journey_id AS member_id,
            coalesce(nullIf(by_profile.profile_id, ''), m.profile_id) AS profile_id,
            m.at AS first_at
          FROM message_events m FINAL
          LEFT JOIN identity by_profile ON by_profile.identity_key = m.profile_id AND by_profile.kind = 'profile'
          WHERE m.workspace_id = {ws:UUID} AND m.journey_id IN {members:Array(String)}
            AND m.at >= {from:DateTime64(3, 'UTC')} AND m.at <= {to:DateTime64(3, 'UTC')}
            AND m.type IN ('sent', 'delivered') AND m.profile_id != ''
        )
        GROUP BY member_id, profile_id
      ),
      events_resolved AS (
        SELECT
          e.name AS name,
          e.timestamp AS timestamp,
          coalesce(
            nullIf(by_user.profile_id, ''),
            nullIf(by_anonymous.profile_id, ''),
            nullIf(by_profile.profile_id, ''),
            e.profile_id
          ) AS profile_id
        FROM events e FINAL
        LEFT JOIN identity by_user ON by_user.identity_key = e.user_id AND by_user.kind = 'user_id'
        LEFT JOIN identity by_anonymous ON by_anonymous.identity_key = e.anonymous_id AND by_anonymous.kind = 'anonymous_id'
        LEFT JOIN identity by_profile ON by_profile.identity_key = e.profile_id AND by_profile.kind = 'profile'
        WHERE e.workspace_id = {ws:UUID}
          AND e.name IN {goal_events:Array(String)}
      ),
      sent AS (
        SELECT member_id,
          -- The k group is people reached on any channel; the figures are e-mail only (#682).
          uniqExactIf(profile_id, profile_id != '') AS reached,
          uniqExactIf(profile_id, profile_id != '' AND event_type = 'sent' AND channel = 'email') AS sent,
          uniqExactIf(profile_id, profile_id != '' AND event_type = 'delivered' AND channel = 'email') AS delivered,
          uniqExactIf(profile_id, profile_id != '' AND event_type = 'clicked' AND channel = 'email') AS clicked,
          uniqExactIf(profile_id, profile_id != '' AND event_type = 'unsubscribed' AND channel = 'email') AS unsubscribed
        FROM (
          SELECT
            m.journey_id AS member_id,
            m.type AS event_type,
            m.channel AS channel,
            coalesce(nullIf(by_profile.profile_id, ''), m.profile_id) AS profile_id
          FROM message_events m FINAL
          LEFT JOIN identity by_profile ON by_profile.identity_key = m.profile_id AND by_profile.kind = 'profile'
          WHERE m.workspace_id = {ws:UUID} AND m.journey_id IN {members:Array(String)}
            AND m.at >= {from:DateTime64(3, 'UTC')} AND m.at <= {to:DateTime64(3, 'UTC')}
            AND m.profile_id != ''
        )
        GROUP BY member_id
      ),
      conv AS (
        SELECT f.member_id, uniqExact(f.profile_id) AS converters
        FROM events_resolved e
        INNER JOIN first f ON f.profile_id = e.profile_id
        WHERE e.timestamp >= f.first_at
          AND e.timestamp <= addDays(f.first_at, {attribution_days:Int32})
        GROUP BY f.member_id
      )
      SELECT s.member_id, s.reached, s.sent, s.delivered, s.clicked, s.unsubscribed, ifNull(c.converters, 0) AS converters
      FROM sent s LEFT JOIN conv c ON c.member_id = s.member_id`,
    query_params: {
      ws: deps.workspaceId,
      members: memberIds,
      from: from.replace('Z', ''),
      to: to.replace('Z', ''),
      goal_events: goalEvents,
      attribution_days: attributionDays,
      ...identityParams.params,
      identity_count: identityParams.count,
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
        reached: Number(r.reached ?? 0),
        sent: Number(r.sent ?? 0),
        delivered: Number(r.delivered ?? 0),
        clicked: Number(r.clicked ?? 0),
        unsubscribed: Number(r.unsubscribed ?? 0),
        converters: Number(r.converters ?? 0),
      },
    ]),
  );
}

async function holdoutResults(
  deps: Deps,
  record: CampaignRecord,
  from: string,
  to: string,
  suppressedMembers: Set<string>,
): Promise<z.infer<typeof holdoutSchema>[]> {
  const out: z.infer<typeof holdoutSchema>[] = [];
  for (const member of sendingMembers(record)) {
    if (member.type !== 'journey' || !member.published) continue;
    try {
      const result = await computeJourneyHoldout(deps, member.artifactId, { from, to });
      // The same k rule as the member row: a suppressed row, or an arm with fewer than k people,
      // hides every count, rate and lift on the holdout card (#586, #590). The journey command
      // already applies the arm rule; this adds the member-row rule and one shared shape.
      if (suppressedMembers.has(member.artifactId) || result.suppressed) {
        out.push({
          journeyId: result.journeyId,
          name: member.name,
          controlGroup: result.controlGroup,
          k: result.k,
          ...suppressHoldout(
            `Suppressed: fewer than k=${K} people in the control or treatment arm, or in the journey member row, so counts and rates are hidden.`,
          ),
        });
        continue;
      }
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

interface SummaryWindow {
  from: string;
  to: string;
  /** True when the default window was shortened to the metric layer's range cap. */
  clamped: boolean;
}

/**
 * The explicit window is used as given. The documented default (campaign start → now) is clamped
 * to the metric layer's cap, because the query layer rejects a longer range before it measures
 * (#588); a campaign with no start date gets the last 400 days instead of the epoch. When that
 * default `from` falls after `to`, the period holds no sends: return an empty window so the caller
 * answers with readiness or zeros instead of a reversed-window error (#747).
 */
/**
 * Whether the summary answers with readiness for a period ending at `to`: unpublished, no sending
 * member, or nothing sent on or before `to`. The planned `startsAt` plays no part, because it is
 * informational: journeys can send before it and it can be edited later (0.14.10 review).
 */
export function campaignNotStarted(input: { published: boolean; sendingMembers: number; firstSendAt: string | null; to: string }): boolean {
  return (
    !input.published || input.sendingMembers === 0 || input.firstSendAt === null || Date.parse(input.firstSendAt) > Date.parse(input.to)
  );
}

export function summaryWindow(
  input: { from?: string; to?: string; startsAt: string | null; firstSendAt?: string | null },
  now: string,
  // Kept for callers that still pass it; a start after `to` now always yields an empty window
  // (#747). Readiness is decided from the campaign, not from this hint.
  _options: { allowFutureStart?: boolean } = {},
): SummaryWindow {
  const to = input.to ?? now;
  const reversed = () =>
    new AppError('invalid_input', 'from must be before to. Move from earlier than to, or omit from to use the campaign start and now.');

  if (input.from !== undefined) {
    if (Date.parse(input.from) > Date.parse(to)) throw reversed();
    return { from: input.from, to, clamped: false };
  }

  // The default window starts at the earlier of the planned start and the first real send, so a
  // campaign that sent before its informational startsAt is still counted (0.14.10 review).
  // Without a planned start the documented default stays "everything, clamped to 400 days" (#588).
  const start =
    input.startsAt == null
      ? '2000-01-01T00:00:00.000Z'
      : input.firstSendAt != null && Date.parse(input.firstSendAt) < Date.parse(input.startsAt)
        ? input.firstSendAt
        : input.startsAt;
  const earliest = new Date(Date.parse(to) - MAX_RANGE_DAYS * 86_400_000).toISOString();
  const clamped = Date.parse(start) < Date.parse(earliest);
  const from = clamped ? earliest : start;
  if (Date.parse(from) > Date.parse(to)) {
    // The campaign's start (or its clamped default) is after the requested `to`, so the period
    // holds no sends even when the campaign has sent later. Return an empty window so the summary
    // answers with readiness or zeros rather than a reversed-window error (#588, #747). This does
    // not depend on hasSent, and the explicit from > to rejection above still applies.
    return { from: to, to, clamped: false };
  }
  return { from, to, clamped };
}

/** One sending member's contribution to the headline totals, before suppression. */
export interface MemberTotalInput {
  /** False when the member has no breakdown row because it never sent; a visible zero. */
  hasRow: boolean;
  /** Distinct people the member reached: the row's group size and the k test. */
  reached: number;
  sent: number;
  delivered: number;
  clicked: number;
  unsubscribed: number;
  converters: number;
}

/**
 * Which sending member rows the campaign summary must hide (#692). Every headline total beside the
 * rows is protected per total, grouped by member rather than by physical row: one hidden member
 * makes exactly one hidden contributor in each total, so the smallest visible member with a value
 * in that total is hidden too. When a total has one hidden member and only zero-valued visible
 * members, hiding one would reveal nothing and the total is withheld instead (the narrow fallback).
 * Hiding a member row hides every figure, so the pass repeats until no total has one hidden member.
 */
export function planMemberSuppression(
  members: readonly MemberTotalInput[],
  k = K,
): { hidden: boolean[]; withheld: string[]; complementary: boolean } {
  const hidden = members.map((member) => member.hasRow && member.reached < k);
  const totals = [
    ['recipients', 'reached'],
    ['email.sent', 'sent'],
    ['email.delivered', 'delivered'],
    ['email.clicked', 'clicked'],
    ['email.unsubscribed', 'unsubscribed'],
    ['campaign.converters', 'converters'],
  ] as const satisfies readonly (readonly [string, keyof MemberTotalInput])[];
  const plan = planComplementarySuppression({
    totals: totals.map(([name]) => name),
    contributors: (name) => {
      const field = totals.find(([entry]) => entry === name)![1];
      // A member with no e-mail activity in the window contributes zero to every e-mail total (an
      // SMS- or push-only member, for one), so its hidden row does not protect those totals; the
      // people and converter totals apply to every member. Any in-window e-mail figure counts, not
      // only sends: sends before `from` can still deliver, be clicked or unsubscribe inside the
      // window (round 4). Excluding too many members only hides or withholds more.
      const emailTotal = name.startsWith('email.');
      return members.map((member, id) => ({
        id,
        group: member.reached,
        value: Number(member[field]),
        hidden: hidden[id]!,
        applies: !emailTotal || member.sent + member.delivered + member.clicked + member.unsubscribed > 0,
      }));
    },
    hide: (_total, id) => {
      const index = Number(id);
      if (hidden[index]) return false;
      hidden[index] = true;
      return true;
    },
  });
  return { hidden, withheld: plan.withheld, complementary: plan.hidden > 0 };
}

export const analyticsCampaignSummary = defineCommand({
  name: 'analytics.campaignSummary',
  title: 'Campaign evaluation',
  description:
    'One campaign’s goal and attribution: recipients reached on any channel, e-mail delivered, clickers, unsubscribers, complaint and unsubscribe rates, converters, conversion rate, revenue per currency and per recipient, progress towards the target when set, and the recipients → delivered → clicked → converted funnel. Includes a row per sending member (broadcast or journey) and the holdout result for journey members with a control group. Member rows below k=5 people reached are suppressed; a currency revenue row below k=5 converters has its revenue suppressed while the rest of the campaign headline stays. Each headline total beside the member rows is protected per total: when exactly one member is hidden, the smallest visible member with a value in that total is hidden too, and a total with no visible member to hide is withheld (null) and named in the notes. A campaign that has not sent yet returns state "not_started" with readiness instead of zeros.',
  input: z.object({
    campaignId: CampaignId,
    from: isoDateTime('from')
      .optional()
      .describe('Count sends at or after this time; defaults to the campaign start, clamped to the last 400 days'),
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
    const ready = await readiness(ctx.tx, record);

    const sending = sendingMembers(record);
    const memberIds = sending.map((m) => m.artifactId);
    const windowTo = input.to ?? now;
    // Readiness decides the response before the default window is built. It follows real sends:
    // a campaign is not started for this period only when nothing was sent on or before `to`. The
    // planned startsAt is informational (journeys can send before it, and it can be edited), so it
    // never hides real results (#588, #747, 0.14.10 review).
    const firstSent = await firstSendAt(deps, memberIds);
    const notStarted = campaignNotStarted({
      published: record.published,
      sendingMembers: sending.length,
      firstSendAt: firstSent,
      to: windowTo,
    });
    const window = summaryWindow({ from: input.from, to: input.to, startsAt: record.startsAt, firstSendAt: firstSent }, now);
    const { from, to } = window;
    // The same campaign identity map the measure queries and the holdout card use (#590): sent
    // recipients union holdout assignments, with one bound decision for all of them.
    const identity = await campaignIdentityMap(deps, {
      campaignIds: [record.id],
      memberIds,
      from,
      to,
    });
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
        ...(window.clamped
          ? [`The default window was shortened to the last ${MAX_RANGE_DAYS} days; pass from to measure an earlier period.`]
          : []),
        ...(identity.overLimit ? [identityUnresolvedNote(identity.limit)] : []),
      ],
    };

    if (notStarted) {
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

    const recipientsValue = cell(totals, 'campaign.recipients');
    const convertersValue = cell(totals, 'campaign.converters');
    const emailSentValue = cell(email, 'email.sent');
    const deliveredValue = cell(email, 'email.delivered');
    const clickersValue = cell(email, 'email.clicked');
    const unsubscribersValue = cell(email, 'email.unsubscribed');
    const complained = cell(email, 'email.complained');
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

    // Revenue goals follow the conversion map, exactly like campaign.converters does.
    const conversionMap = await publishedSingleton(ctx.tx, 'conversion_map');
    const goalEvents = goalEventsFor(
      record.goal,
      (conversionMap?.rules ?? []).map((r) => r.event),
    );
    const breakdown = await memberBreakdown(deps, memberIds, from, to, goalEvents, record.goal.attributionDays, identity);
    // The same k rule the query layer applies to a dimension group: a member row whose group of
    // people reached is below k has every count and derived rate suppressed (null), and is
    // counted in meta.suppressed. Every headline total beside the rows is protected per total
    // (#692): the people total and each summed headline measure. One hidden member is one hidden
    // contributor in each; hide the smallest visible member with a value in that total, or withhold
    // the total when every visible member is zero. The member order is deterministic, so a tie is.
    const memberTotals = sending.map((m) => {
      const row = breakdown.get(m.artifactId);
      return row
        ? {
            hasRow: true,
            reached: row.reached,
            sent: row.sent,
            delivered: row.delivered,
            clicked: row.clicked,
            unsubscribed: row.unsubscribed,
            converters: row.converters,
          }
        : { hasRow: false, reached: 0, sent: 0, delivered: 0, clicked: 0, unsubscribed: 0, converters: 0 };
    });
    const memberPlan = planMemberSuppression(memberTotals);
    const withheld = new Set(memberPlan.withheld);
    const visible = (name: string, value: number) => (withheld.has(name) ? null : value);
    const recipients = visible('recipients', recipientsValue);
    const converters = visible('campaign.converters', convertersValue);
    const emailSent = visible('email.sent', emailSentValue);
    const delivered = visible('email.delivered', deliveredValue);
    const clickers = visible('email.clicked', clickersValue);
    const unsubscribers = visible('email.unsubscribed', unsubscribersValue);
    const conversionRate = recipients !== null && recipients > 0 && converters !== null ? converters / recipients : null;
    const revenuePerRecipient = revenueRows.map((r) => ({
      currency: r.currency,
      amount: recipients === null ? null : recipients === 0 ? 0 : r.amount / recipients,
    }));

    let targetProgress: number | null = null;
    if (record.goal.target && record.goal.target > 0) {
      if (record.goal.kind === 'revenue' && revenueRows.length === 1) targetProgress = revenueRows[0].amount / record.goal.target;
      else if (record.goal.kind !== 'revenue' && converters !== null) targetProgress = converters / record.goal.target;
    }

    let memberSuppressed = 0;
    const members = sending.map((m, index) => {
      const row = breakdown.get(m.artifactId);
      if (!row) {
        return {
          artifactId: m.artifactId,
          name: m.name,
          type: m.type,
          role: m.role,
          sent: 0,
          delivered: 0,
          clickRate: null,
          unsubscribeRate: null,
          converters: 0,
          suppressed: false,
        };
      }
      if (memberPlan.hidden[index]) {
        memberSuppressed++;
        return {
          artifactId: m.artifactId,
          name: m.name,
          type: m.type,
          role: m.role,
          sent: null,
          delivered: null,
          clickRate: null,
          unsubscribeRate: null,
          converters: null,
          suppressed: true,
        };
      }
      return {
        artifactId: m.artifactId,
        name: m.name,
        type: m.type,
        role: m.role,
        sent: row.sent,
        delivered: row.delivered,
        clickRate: row.delivered ? row.clicked / row.delivered : null,
        unsubscribeRate: row.delivered ? row.unsubscribed / row.delivered : null,
        converters: row.converters,
        suppressed: false,
      };
    });

    // E-mail figures divide by the e-mail base, never by the all-channel recipient total. The
    // recipients and converted steps stay campaign-wide (#682).
    const funnel = [
      {
        step: 'recipients' as const,
        count: recipients,
        stepRate: null,
        shareOfRecipients: recipients !== null && recipients > 0 ? 1 : null,
      },
      {
        step: 'delivered' as const,
        count: delivered,
        stepRate: emailSent !== null && emailSent > 0 && delivered !== null ? delivered / emailSent : null,
        shareOfRecipients: emailSent !== null && emailSent > 0 && delivered !== null ? delivered / emailSent : null,
      },
      {
        step: 'clicked' as const,
        count: clickers,
        stepRate: delivered !== null && delivered > 0 && clickers !== null ? clickers / delivered : null,
        shareOfRecipients: emailSent !== null && emailSent > 0 && clickers !== null ? clickers / emailSent : null,
      },
      {
        step: 'converted' as const,
        count: converters,
        stepRate: clickers !== null && clickers > 0 && converters !== null ? converters / clickers : null,
        shareOfRecipients: recipients !== null && recipients > 0 && converters !== null ? converters / recipients : null,
      },
    ];

    const suppressedMembers = new Set(members.filter((m) => m.suppressed).map((m) => m.artifactId));
    const holdouts = await holdoutResults(deps, record, from, to, suppressedMembers);
    const suppressedHoldouts = holdouts.filter((h) => h.suppressed).length;
    const notes = [...new Set([...totals.meta.notes, ...email.meta.notes, ...revenue.meta.notes, ...baseMeta.notes])];
    if (memberSuppressed) notes.push(`Member rows with fewer than k=${K} people reached have their counts suppressed.`);
    if (memberPlan.complementary)
      notes.push('One further member row was suppressed so a member below k cannot be derived from the campaign total.');
    if (withheld.size)
      notes.push(
        `Totals withheld because they had one hidden member and no visible member with a value to hide in its place: ${[...withheld].join(', ')}.`,
      );
    if (suppressedHoldouts)
      notes.push(`Journey holdouts with fewer than k=${K} people in an arm or in a suppressed member row have their counts suppressed.`);

    return {
      campaignId: record.id,
      name: record.name,
      state: 'measured' as const,
      goal: record.goal,
      headline: {
        recipients,
        emailSent,
        delivered,
        clickers,
        unsubscribers,
        complaintRate: delivered !== null && delivered > 0 ? complained / delivered : null,
        unsubscribeRate: delivered !== null && delivered > 0 && unsubscribers !== null ? unsubscribers / delivered : null,
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
        suppressed: totals.meta.suppressed + email.meta.suppressed + revenue.meta.suppressed + memberSuppressed + suppressedHoldouts,
        k: K,
        notes,
      },
    };
  },
});
