import { runAnalyticsQuery } from '@agentic-marketing/analytics';
import type { MandateView } from '@agentic-marketing/commands';
import { outboxPublicationOf, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
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

/** The base counts behind one verdict: distinct messages per event type, and how many were sent. */
interface Counts {
  sent: number;
  counts: Map<string, number>;
}

/** Whether publication of the agent's own message events is behind, and how many rows are dead. */
interface Publication {
  outstanding: number;
  failed: number;
}

/**
 * A freshness note for a decision that had to read the message log because ClickHouse did not have
 * the agent's events yet. It names the reason, so the person who receives the hold (or the agent
 * reading the refusal) can see that the verdict is not just about published events.
 */
function freshnessNote(publication: Publication): string {
  const reasons = [
    publication.outstanding
      ? `${publication.outstanding} message event${publication.outstanding === 1 ? ' is' : 's are'} still unpublished`
      : '',
    publication.failed ? `${publication.failed} ${publication.failed === 1 ? 'was' : 'were'} dead-lettered` : '',
  ].filter(Boolean);
  return ` The decision also counted the message log and consent ledger because ${reasons.join(' and ')}.`;
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

  // The published evidence, read exactly as before 0.15.0 read it (through the metric layer).
  const published = await publishedCounts(deps, active, broadcasts, directMessages, since);
  const verdict = (counts: Counts) => {
    // A minimum sample protects people from a rule that fires on two sends and one bounce.
    if (counts.sent < g.minSent) return null;
    for (const [measure, , label, key] of active) {
      const limit = g[key];
      if (limit === undefined) continue;
      const rate = (counts.counts.get(measure) ?? 0) / counts.sent;
      if (rate > limit)
        return `This agent’s sends in the last ${WINDOW_DAYS[g.window] ?? 7} days have a ${label} rate of ${pct(rate)}, above its mandate’s guardrail of ${pct(limit)}.`;
    }
    return null;
  };
  const publishedVerdict = verdict(published);
  if (publishedVerdict) return publishedVerdict;

  // #1008: message events reach ClickHouse after the transaction that records them commits, so a
  // bounce, complaint or unsubscribe can be committed and not yet published. Before 0.15.0 the
  // events were written during the request, so this evidence is newer than "no breach". Judge the
  // message log and the consent ledger too while the agent's own publication is behind, or when a
  // row was dead-lettered and will never appear there. A verdict can only get stricter, never
  // looser: the two sources are judged on their own samples rather than mixed.
  const publication = await publicationOf(deps.tx, deps.workspaceId, broadcasts, directMessages);
  if (publication.outstanding || publication.failed) {
    const logged = await messageLogCounts(deps.tx, deps.workspaceId, broadcasts, directMessages, since);
    const loggedVerdict = verdict(logged);
    if (loggedVerdict) return `${loggedVerdict}${freshnessNote(publication)}`;
    logger.info(
      { agent: agentId, workspace: deps.workspaceId, ...publication },
      'guardrail decision read the message log because message events are not published yet',
    );
  }
  return null;
}

/** The metric-layer counts: broadcasts through the analytics query, direct sends per message. */
async function publishedCounts(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
  active: ActiveChecks,
  broadcasts: string[],
  directMessages: string[],
  since: Date,
): Promise<Counts> {
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
    const stats = await deps.events.messageStats(deps.workspaceId, { since, messageIds: directMessages });
    sent += stats.sent ?? 0;
    for (const [measure, type] of active) counts.set(measure, (counts.get(measure) ?? 0) + (stats[type] ?? 0));
  }
  return { sent, counts };
}

/**
 * The same base counts from SQL, the source the transaction wrote before the outbox published it:
 * the message log carries the send, bounce and complaint outcome, and the consent ledger the
 * withdrawals with the message they came from. Unsubscribes a provider reports are recorded with
 * `source = 'unsubscribe'` and the message id in the proof, which is how a withdrawal is attributed
 * to a send here (the ledger's `message_id` column carries the provider's event id). The window is
 * the message's creation time, which is when its decision event is recorded.
 */
async function messageLogCounts(tx: Tx, workspaceId: string, broadcasts: string[], directMessages: string[], since: Date): Promise<Counts> {
  const { rows } = await tx.execute<{ sent: number; bounced: number; complained: number }>(sql`
    SELECT count(*) FILTER (WHERE status IN ('sent', 'delivered', 'bounced', 'complained'))::int AS sent,
           count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
           count(*) FILTER (WHERE status = 'complained')::int AS complained
    FROM messages
    WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
      AND (journey_id = ANY(${sql.param(broadcasts)}::text[]) OR id = ANY(${sql.param(directMessages)}::text[]))`);
  const { rows: unsubscribed } = await tx.execute<{ n: number }>(sql`
    SELECT count(DISTINCT m.id)::int AS n
    FROM consent_records c
    JOIN messages m ON m.workspace_id = c.workspace_id AND m.id = c.proof->>'messageId'
    WHERE c.workspace_id = ${workspaceId} AND c.source = 'unsubscribe' AND c.recorded_at >= ${since}
      AND (m.journey_id = ANY(${sql.param(broadcasts)}::text[]) OR m.id = ANY(${sql.param(directMessages)}::text[]))`);
  const counts = new Map<string, number>([
    ['email.unsubscribed', Number(unsubscribed[0]?.n ?? 0)],
    ['email.complained', Number(rows[0]?.complained ?? 0)],
    ['email.bounced', Number(rows[0]?.bounced ?? 0)],
  ]);
  return { sent: Number(rows[0]?.sent ?? 0), counts };
}

/** Whether the outbox still owes ClickHouse events for the agent's own sends. */
async function publicationOf(tx: Tx, workspaceId: string, broadcasts: string[], messageIds: string[]): Promise<Publication> {
  return outboxPublicationOf(tx, workspaceId, { subjects: broadcasts, messageIds });
}
