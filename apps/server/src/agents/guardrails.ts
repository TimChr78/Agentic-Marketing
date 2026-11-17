import { runAnalyticsQuery } from '@agentic-marketing/analytics';
import type { MandateView } from '@agentic-marketing/commands';
import { pendingMessageEventPayloads, schema, type Tx } from '@agentic-marketing/db';
import { type EventStore, type MessageEvent, parseMessageEventPayload } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, gt, sql } from 'drizzle-orm';

// A mandate's guardrails (ADR-0016, #224): before an agent sends again, its own recent sends are
// judged on the metric layer. A breach sends the next send to a person; the full guardian that
// pauses agents by itself is Phase 19.

const WINDOW_DAYS: Record<string, number> = { P7D: 7, P14D: 14, P30D: 30 };
const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** Metric-layer measures and the message-event type each counts. */
const CHECKS = [
  ['email.unsubscribed', 'unsubscribed', 'unsubscribe', 'unsubscribeRate'],
  ['email.complained', 'complained', 'complaint', 'complaintRate'],
  ['email.bounced', 'bounced', 'bounce', 'bounceRate'],
] as const;

type ActiveChecks = readonly (typeof CHECKS)[number][];

/**
 * Outbox rows one check reads. Each row is one transaction's batch of message events, and the query
 * carries every event as parameters, so the bound keeps one check's ClickHouse statement a sane
 * size. An agent with more queued evidence than this is not judged on a partial snapshot: the
 * decision fails safe instead (see `unboundedReason`).
 */
export const GUARDRAIL_PENDING_EVENT_LIMIT = 500;

/** The same bound for the events themselves, since one row may carry a batch. */
const GUARDRAIL_PENDING_MESSAGE_LIMIT = 1000;

/** The agent's own message events that were committed and not (yet, or ever) published. */
interface PendingSnapshot {
  events: MessageEvent[];
  /** How many of those events sit in a dead-lettered row (`am outbox` requeues them). */
  deadLettered: number;
  truncated: boolean;
}

/**
 * Why a check that cannot read all of the agent's queued evidence refuses instead of deciding:
 * a partial snapshot is not a conservative one, and the send waits for a person (#1008).
 */
function unboundedReason(): string {
  return `This agent’s guardrails cannot be checked: too many of its message events are waiting to be published or dead-lettered for one check to read, so the metrics would be incomplete. A person decides this send until the queue catches up (or is requeued with \`am outbox\`).`;
}

/**
 * Says that the verdict counted events ClickHouse had not received yet, so a person reading a hold
 * (or an agent reading a refusal) can tell why the published numbers alone might disagree.
 */
function queuedNote(snapshot: PendingSnapshot): string {
  if (!snapshot.events.length) return '';
  const pending = snapshot.events.length - snapshot.deadLettered;
  const parts = [
    pending > 0
      ? `${pending} message event${pending === 1 ? ' is' : 's are'} still queued for publication`
      : `${snapshot.deadLettered} message event${snapshot.deadLettered === 1 ? ' is' : 's are'} in a dead-lettered row and will publish only after \`am outbox\``,
    pending > 0 && snapshot.deadLettered > 0
      ? `${snapshot.deadLettered} of them ${snapshot.deadLettered === 1 ? 'is' : 'are'} dead-lettered (\`am outbox\` requeues them)`
      : '',
  ].filter(Boolean);
  return ` The decision also counted ${parts.join('; ')}.`;
}

export async function mandateGuardrailBreach(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
  agentId: string,
  mandate: MandateView,
): Promise<string | null> {
  const g = mandate.guardrails;
  // Rates from the base counts: the metric layer's ratio measures hide small groups for privacy,
  // while this check is an internal decision about the agent's own sends.
  const active = CHECKS.filter(([, , , key]) => g[key] !== undefined);
  if (!active.length) return null;
  const since = new Date(Date.now() - (WINDOW_DAYS[g.window] ?? 7) * 86_400_000);
  // The agent's own sends in the window: the broadcasts it published itself (or through a hold)
  // and its direct sends, each linked to the message it created on the ledger (#265). Journey
  // sends are not attributed here; a journey is judged by its own holdout and alerts.
  const rows = await deps.tx
    .select({ target: schema.agentActions.target, impact: schema.agentActions.impact })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.agentId, agentId),
        sql`${schema.agentActions.actionClass} IN ('send.broadcast', 'send.direct')`,
        sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
        eq(schema.agentActions.ok, true),
        gt(schema.agentActions.at, since),
      ),
    );
  const broadcasts = [...new Set(rows.flatMap((r) => (r.target ?? '').split(',')).filter((id) => id.startsWith('bct_')))];
  const directMessages = [
    ...new Set(rows.map((r) => r.impact.messageId).filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))),
  ];
  if (!broadcasts.length && !directMessages.length) return null;

  // #1008: message events reach ClickHouse after the transaction that recorded them commits, so a
  // bounce, complaint or unsubscribe can be committed and not published. Snapshot the agent's own
  // queued events FIRST, then read the metric layer with them: an event published between the two
  // is in one of the halves and is de-duplicated, so the decision sees exactly what publication
  // will produce. Reconstructing this from SQL status cannot work: a soft bounce leaves the status
  // `sent`, a later complaint overwrites an earlier bounce, and a broadcast's denominator is people,
  // not messages (#1008 review).
  const snapshot = await pendingEventsOf(deps.tx, deps.workspaceId, broadcasts, directMessages, since);
  if (snapshot.truncated) return unboundedReason();
  if (snapshot.events.length)
    logger.info(
      { agent: agentId, workspace: deps.workspaceId, queued: snapshot.events.length, deadLettered: snapshot.deadLettered },
      'guardrail decision read message events that the outbox has not published yet',
    );

  const counts = await publishedCounts(deps, active, broadcasts, directMessages, since, snapshot.events);
  // A minimum sample protects people from a rule that fires on two sends and one bounce.
  if (counts.sent < g.minSent) return null;
  for (const [measure, , label, key] of active) {
    const limit = g[key];
    if (limit === undefined) continue;
    const rate = (counts.counts.get(measure) ?? 0) / counts.sent;
    if (rate > limit)
      return `This agent’s sends in the last ${WINDOW_DAYS[g.window] ?? 7} days have a ${label} rate of ${pct(rate)}, above its mandate’s guardrail of ${pct(limit)}.${queuedNote(snapshot)}`;
  }
  return null;
}

/**
 * The agent's queued events, parsed, de-duplicated by the table's replacing key and filtered to the
 * same sends and window the metric read describes. A row whose payload is not a valid batch was
 * never a deliverable event, so it contributes nothing.
 */
async function pendingEventsOf(
  tx: Tx,
  workspaceId: string,
  broadcasts: string[],
  directMessages: string[],
  since: Date,
): Promise<PendingSnapshot> {
  const { batches, truncated } = await pendingMessageEventPayloads(
    tx,
    workspaceId,
    { subjects: broadcasts, messageIds: directMessages },
    GUARDRAIL_PENDING_EVENT_LIMIT,
  );
  const events: MessageEvent[] = [];
  const seen = new Set<string>();
  let deadLettered = 0;
  for (const batch of batches) {
    let parsed: MessageEvent[];
    try {
      parsed = parseMessageEventPayload(batch.payload);
    } catch {
      continue;
    }
    for (const event of parsed) {
      if (event.workspaceId !== workspaceId) continue;
      const relevant =
        (batch.subjectRef !== null && broadcasts.includes(batch.subjectRef)) ||
        broadcasts.includes(event.journeyId) ||
        directMessages.includes(event.messageId);
      if (!relevant) continue;
      if (Number.isNaN(Date.parse(event.at)) || Date.parse(event.at) < since.getTime()) continue;
      // The table's replacing key: the same event in two rows (or also published) counts once.
      const identity = `${event.messageId}\u0000${event.type}\u0000${event.eventId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      events.push(event);
      if (batch.deadLettered) deadLettered++;
    }
  }
  return {
    events,
    deadLettered,
    truncated: truncated || events.length > GUARDRAIL_PENDING_MESSAGE_LIMIT,
  };
}

/**
 * The metric-layer counts over published events plus the agent's queued ones. For broadcasts the
 * analytic query counts distinct people; for direct sends the message events of those messages
 * count distinct messages per type. Both keep their own semantics, because the queued events travel
 * through the same aggregation as the published ones.
 */
async function publishedCounts(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
  active: ActiveChecks,
  broadcasts: string[],
  directMessages: string[],
  since: Date,
  pending: readonly MessageEvent[],
): Promise<{ sent: number; counts: Map<string, number> }> {
  const counts = new Map<string, number>(active.map(([measure]) => [measure, 0]));
  let sent = 0;

  if (broadcasts.length) {
    const result = await runAnalyticsQuery(
      { tx: deps.tx, events: deps.events, workspaceId: deps.workspaceId },
      {
        measures: ['email.sent', ...active.map(([measure]) => measure)],
        dimensions: [],
        from: since.toISOString(),
        to: new Date().toISOString(),
        filters: { broadcast: broadcasts },
        limit: 1,
      },
      { pendingMessageEvents: pending },
    );
    const value = (name: string) => {
      const i = result.columns.findIndex((c) => c.name === name);
      const v = i < 0 ? null : result.rows[0]?.[i];
      return typeof v === 'number' ? v : null;
    };
    sent += value('email.sent') ?? 0;
    for (const [measure] of active) counts.set(measure, value(measure) ?? 0);
  }

  if (directMessages.length) {
    // The message events of the direct sends: distinct messages per event type, the same base
    // counts the metric layer uses.
    const stats = await deps.events.messageStats(deps.workspaceId, { since, messageIds: directMessages, pendingEvents: pending });
    sent += stats.sent ?? 0;
    for (const [measure, type] of active) counts.set(measure, (counts.get(measure) ?? 0) + (stats[type] ?? 0));
  }
  return { sent, counts };
}
