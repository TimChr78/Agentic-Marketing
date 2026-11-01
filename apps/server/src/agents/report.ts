import { runAnalyticsQuery } from '@agentic-marketing/analytics';
import { artifactTypes } from '@agentic-marketing/artifacts';
import type { AgentOutcomes } from '@agentic-marketing/commands';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { computeJourneyHoldout } from '@agentic-marketing/journeys';
import { and, eq, gte, lt } from 'drizzle-orm';

// What an agent's actions led to (ADR-0016 §6, #310): the broadcasts it published and the direct
// messages it sent, measured on the metric layer and the message events, the journeys it
// published against their control groups, and its mandate's goals on the same artifacts.

type Range = { from: Date; to: Date };
const EMAIL_MEASURES = ['email.sent', 'email.opened', 'email.clicked', 'email.unsubscribed', 'email.complained', 'email.bounced'] as const;

export async function agentOutcomes(
  deps: { tx: Tx; events: EventStore; workspaceId: string },
  agentId: string,
  range: Range,
  goals: { measure: string; target?: number; direction: 'up' | 'down' }[],
): Promise<AgentOutcomes> {
  const a = schema.agentActions;
  const ran = await deps.tx
    .select({ actionClass: a.actionClass, target: a.target, impact: a.impact })
    .from(a)
    .where(and(eq(a.agentId, agentId), eq(a.decision, 'allow'), eq(a.ok, true), gte(a.at, range.from), lt(a.at, range.to)));
  const ids = (prefix: string) => [...new Set(ran.flatMap((r) => (r.target ?? '').split(',')).filter((id) => id.startsWith(prefix)))];
  const broadcasts = ids('bct_');
  // Journey ids use the artifact type's prefix (#322).
  const journeys = ids(`${artifactTypes.journey.prefix}_`);
  const directIds = [
    ...new Set(
      ran
        .filter((r) => r.actionClass === 'send.direct' && typeof r.impact?.messageId === 'string')
        .map((r) => r.impact.messageId as string),
    ),
  ];

  const query = (measures: string[]) =>
    runAnalyticsQuery(
      { tx: deps.tx, events: deps.events, workspaceId: deps.workspaceId },
      {
        measures,
        dimensions: [],
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        filters: { broadcast: broadcasts },
        limit: 1,
      },
    );
  const cell = (result: Awaited<ReturnType<typeof query>>, name: string) => {
    const i = result.columns.findIndex((c) => c.name === name);
    const v = i < 0 ? null : result.rows[0]?.[i];
    return typeof v === 'number' ? v : null;
  };

  let email: AgentOutcomes['broadcasts'] = null;
  if (broadcasts.length) {
    const result = await query([...EMAIL_MEASURES]);
    email = {
      count: broadcasts.length,
      sent: cell(result, 'email.sent') ?? 0,
      opened: cell(result, 'email.opened') ?? 0,
      clicked: cell(result, 'email.clicked') ?? 0,
      unsubscribed: cell(result, 'email.unsubscribed') ?? 0,
      complained: cell(result, 'email.complained') ?? 0,
      bounced: cell(result, 'email.bounced') ?? 0,
    };
  }

  let direct: AgentOutcomes['direct'] = null;
  if (directIds.length) {
    // Only events inside the period, so a report on last month does not count today's opens (#323).
    const stats = await deps.events.messageStats(deps.workspaceId, { since: range.from, until: range.to, messageIds: directIds });
    direct = {
      count: directIds.length,
      sent: stats.sent ?? 0,
      opened: stats.opened ?? 0,
      clicked: stats.clicked ?? 0,
      unsubscribed: stats.unsubscribed ?? 0,
      complained: stats.complained ?? 0,
      bounced: stats.bounced ?? 0,
    };
  }

  // Journeys it published, against their control groups where they have one.
  const holdouts: AgentOutcomes['journeys'] = [];
  for (const id of journeys) {
    try {
      const r = await computeJourneyHoldout(deps, id, { from: range.from.toISOString(), to: range.to.toISOString() });
      holdouts.push({ id, verdict: r.verdict, note: r.note });
    } catch (err) {
      holdouts.push({ id, verdict: null, note: (err as Error).message });
    }
  }

  // Mandate goals on the agent's own broadcasts; a measure the metric layer cannot answer for them is reported as such.
  const goalResults: AgentOutcomes['goals'] = [];
  for (const g of goals) {
    if (!broadcasts.length) {
      goalResults.push({ ...g, value: null, met: null, note: 'No broadcasts by this agent in the period.' });
      continue;
    }
    try {
      const value = cell(await query([g.measure]), g.measure);
      const met = value === null || g.target === undefined ? null : g.direction === 'up' ? value >= g.target : value <= g.target;
      goalResults.push({ ...g, value, met, note: value === null ? 'No value for the period (or the group is too small to show).' : null });
    } catch (err) {
      goalResults.push({ ...g, value: null, met: null, note: (err as Error).message });
    }
  }
  return { broadcasts: email, direct, journeys: holdouts, goals: goalResults };
}
