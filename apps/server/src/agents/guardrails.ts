import { runAnalyticsQuery } from '@agentic-marketing/analytics';
import type { MandateView } from '@agentic-marketing/commands';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
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

  if (sent < g.minSent) return null;
  for (const [measure, , label, key] of active) {
    const limit = g[key];
    if (limit === undefined) continue;
    const rate = (counts.get(measure) ?? 0) / sent;
    if (rate > limit)
      return `This agent’s sends in the last ${WINDOW_DAYS[g.window] ?? 7} days have a ${label} rate of ${pct(rate)}, above its mandate’s guardrail of ${pct(limit)}.`;
  }
  return null;
}
