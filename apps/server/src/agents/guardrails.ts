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

export async function mandateGuardrailBreach(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
  agentId: string,
  mandate: MandateView,
): Promise<string | null> {
  const g = mandate.guardrails;
  const checks = [
    ['email.unsubscribe_rate', 'unsubscribe', g.unsubscribeRate],
    ['email.complaint_rate', 'complaint', g.complaintRate],
    ['email.bounce_rate', 'bounce', g.bounceRate],
  ] as const;
  if (!checks.some(([, , limit]) => limit !== undefined)) return null;
  const since = new Date(Date.now() - (WINDOW_DAYS[g.window] ?? 7) * 86_400_000);
  // The broadcasts this agent published itself (or through a hold) in the window.
  const rows = await deps.tx
    .select({ target: schema.agentActions.target })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.agentId, agentId),
        eq(schema.agentActions.actionClass, 'send.broadcast'),
        sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
        eq(schema.agentActions.ok, true),
        gt(schema.agentActions.at, since),
      ),
    );
  const broadcasts = [...new Set(rows.flatMap((r) => (r.target ?? '').split(',')).filter((id) => id.startsWith('bct_')))];
  if (!broadcasts.length) return null;
  const result = await runAnalyticsQuery(
    { tx: deps.tx, events: deps.events, workspaceId: deps.workspaceId },
    {
      measures: ['email.sent', ...checks.filter(([, , limit]) => limit !== undefined).map(([m]) => m)],
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
  const sent = value('email.sent') ?? 0;
  if (sent < g.minSent) return null;
  for (const [measure, label, limit] of checks) {
    if (limit === undefined) continue;
    const rate = value(measure);
    if (rate !== null && rate > limit)
      return `This agent’s sends in the last ${WINDOW_DAYS[g.window] ?? 7} days have a ${label} rate of ${pct(rate)}, above its mandate’s guardrail of ${pct(limit)}.`;
  }
  return null;
}
