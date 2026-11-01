import { type ActionClass, autonomySettings, type CommandContext, type MandateView, userPrincipal } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { type AgentMandate, artifactTypes, publishValidators } from './types';

// Mandates (ADR-0016, #223–#225): the agent's active mandate for the policy engine, its working
// hours, the checks before one is published, and running held changes when their veto window ends.

export interface ActiveMandate {
  view: MandateView;
  content: AgentMandate;
  /** Why now is outside the mandate's working hours or on a blackout date, or null. */
  outsideHours: string | null;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** The day and HH:MM of `now` in a time zone. */
function localNow(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: get('weekday').toLowerCase().slice(0, 3),
    time: `${get('hour')}:${get('minute')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Why `now` is outside the mandate's working hours or on a blackout date (in the workspace time zone), or null. */
export function outsideWorkingHours(
  m: Pick<AgentMandate, 'workingHours' | 'blackoutDates'>,
  timeZone: string,
  now = new Date(),
): string | null {
  const local = localNow(now, timeZone);
  if (m.blackoutDates.includes(local.date)) return `${local.date} is a blackout date in the agent’s mandate.`;
  const w = m.workingHours;
  if (!w) return null;
  const overnight = w.start > w.end;
  const inside = overnight ? local.time >= w.start || local.time < w.end : local.time >= w.start && local.time < w.end;
  if (!inside) return `It is ${local.time} in ${timeZone}; the mandate allows sends between ${w.start} and ${w.end}.`;
  // The part of an overnight window after midnight belongs to the day it started (#233).
  const windowDay = overnight && local.time < w.end ? DAYS[(DAYS.indexOf(local.day as (typeof DAYS)[number]) + 6) % 7] : local.day;
  if (w.days?.length && !w.days.includes(windowDay as (typeof DAYS)[number]))
    return `The mandate allows sends in windows starting on ${w.days.join(', ')} only (${timeZone}).`;
  return null;
}

/** The agent's mandate that applies now: published, not archived, for this agent, not expired. */
export async function activeMandate(tx: Tx, agentId: string, now = new Date()): Promise<ActiveMandate | null> {
  const rows = await tx
    .select({ id: schema.artifacts.id, version: schema.artifacts.publishedVersion, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(
        eq(schema.artifacts.type, 'agent_mandate'),
        eq(schema.artifacts.archived, false),
        isNotNull(schema.artifacts.publishedVersion),
        sql`${schema.artifactVersions.content}->>'agent' = ${agentId}`,
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt));
  for (const r of rows) {
    const parsed = artifactTypes.agent_mandate.content.safeParse(r.content);
    if (!parsed.success || new Date(parsed.data.validUntil) <= now) continue;
    const m = parsed.data;
    const [w] = await tx.select({ timeZone: schema.workspaces.timeZone }).from(schema.workspaces);
    return {
      content: m,
      outsideHours: outsideWorkingHours(m, w?.timeZone ?? 'UTC', now),
      view: {
        id: r.id,
        version: r.version!,
        levels: m.levels as Partial<Record<ActionClass, number>>,
        scope: m.scope,
        limits: m.limits,
        holdWindow: m.holdWindow,
        independentCheck: m.independentCheck,
        guardrails: m.guardrails,
        purpose: m.purpose,
        learning: m.learning,
        goals: m.goals,
        shadow: m.shadow as MandateView['shadow'],
      },
    };
  }
  return null;
}

// Before a mandate is published: the agent exists, the levels fit the workspace ceilings, it does
// not overlap another active mandate for the same agent, and it ends within a year.
publishValidators.set('agent_mandate', async (content, tx: Tx, artifact) => {
  const m = content as AgentMandate;
  const problems: string[] = [];
  const [agent] = await tx.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.id, m.agent));
  if (!agent) problems.push(`agent ${m.agent} does not exist`);
  else if (agent.status === 'revoked') problems.push(`agent ${m.agent} is revoked`);
  const [w] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
  const settings = autonomySettings(w?.autonomy);
  for (const [cls, level] of Object.entries(m.levels)) {
    // A class in shadow only records what the agent would do, so it may be above the ceiling (#256).
    // Level 4 may be recorded in shadow without having earned it: that is how it is earned (#309).
    if (m.shadow === true || (Array.isArray(m.shadow) && m.shadow.includes(cls as (typeof m.shadow)[number]))) continue;
    const ceiling = settings.maxLevel[cls as ActionClass] ?? 1;
    if ((level ?? 0) > ceiling)
      problems.push(`levels.${cls} is ${level}, above the workspace ceiling of ${ceiling} (raise it in Settings → Agents first)`);
    if (level === 4) {
      const missing = await l4Missing(tx, m.agent, cls as ActionClass);
      if (missing) problems.push(`levels.${cls} is 4 (run the loop), which is earned: ${missing}`);
    }
  }
  const until = new Date(m.validUntil).getTime();
  if (until <= Date.now()) problems.push('validUntil is in the past');
  if (until > Date.now() + 366 * 86_400_000) problems.push('validUntil is more than a year away; mandates are reviewed at least yearly');
  const others = await activeMandate(tx, m.agent);
  if (others && others.view.id !== artifact?.id)
    problems.push(`agent ${m.agent} already has an active mandate (${others.view.id}); archive it or let it expire first`);
  return problems;
});

/** How long an agent must have run a class at level 3, or in shadow, before a mandate may grant level 4. */
export const L4_EARNING_DAYS = 28;

/**
 * What an agent still lacks to be granted level 4 (run the loop) for a class, or null when it has
 * earned it (design §3.3, #309): it ran the class autonomously (level 3, decided by a mandate) for
 * at least four weeks with no guardian episode in that time and no cap in force, or its mandate
 * recorded the class in shadow mode for four weeks without a decision a person rejected.
 */
export async function l4Missing(tx: Tx, agentId: string, cls: ActionClass, now = new Date()): Promise<string | null> {
  const since = new Date(now.getTime() - L4_EARNING_DAYS * 86_400_000);
  const [agent] = await tx.select({ guard: schema.agents.guard }).from(schema.agents).where(eq(schema.agents.id, agentId));
  if (agent?.guard) return 'the guardian has limited this agent; clear it first';
  const [episodes] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.guardianEvents)
    .where(and(eq(schema.guardianEvents.agentId, agentId), sql`${schema.guardianEvents.at} > ${since}`));
  const a = schema.agentActions;
  // Level 3 or above, as the engine recorded it (#327): a held change that ran after its veto window is level 2.
  const [l3] = await tx
    .select({ first: sql<Date | null>`min(${a.at})` })
    .from(a)
    .where(
      and(
        eq(a.agentId, agentId),
        eq(a.actionClass, cls),
        eq(a.decision, 'allow'),
        eq(a.ok, true),
        sql`${a.level} >= 3`,
        sql`${a.shadow} IS NULL`,
      ),
    );
  const l3Earned = !!l3?.first && new Date(l3.first) <= since && (episodes?.n ?? 0) === 0;
  if (l3Earned) return null;
  // Shadow mode: what the mandate would have run, and no such action a person rejected.
  const [shadow] = await tx
    .select({
      first: sql<Date | null>`min(${a.at})`,
      rejected: sql<number>`count(*) FILTER (WHERE ${a.shadow}->>'decision' IN ('allow', 'hold') AND EXISTS (
        SELECT 1 FROM approval_requests ar WHERE ar.id = ${a.impact}->>'approvalId' AND ar.status = 'rejected'))::int`,
    })
    .from(a)
    .where(and(eq(a.agentId, agentId), eq(a.actionClass, cls), sql`${a.shadow} IS NOT NULL`));
  if (shadow?.first && new Date(shadow.first) <= since && (shadow.rejected ?? 0) === 0) return null;
  if ((episodes?.n ?? 0) > 0) return `the guardian acted on this agent in the last ${L4_EARNING_DAYS} days`;
  if (shadow?.first && (shadow.rejected ?? 0) > 0)
    return `people rejected ${shadow.rejected} of its shadow decisions for ${cls}; run it at level 3 or in shadow for ${L4_EARNING_DAYS} days without that`;
  return `it needs ${L4_EARNING_DAYS} days of ${cls} at level 3 without a guardian episode, or ${L4_EARNING_DAYS} days in shadow mode without a decision people rejected`;
}

/** ms of an ISO hold window such as PT2H. */
export function holdWindowMs(window: string): number {
  const m = /^PT(\d+)([HM])$/.exec(window);
  return m ? Number(m[1]) * (m[2] === 'H' ? 3_600_000 : 60_000) : 2 * 3_600_000;
}

/** A context for scheduler work inside one workspace (publishing needs only the workspace and the transaction). */
export function systemContext(tx: Tx, workspaceId: string, services: CommandContext['services']): CommandContext {
  return { principal: userPrincipal('system', workspaceId, 'owner'), tx, services };
}

/** The ids of pending held changes whose veto window has ended, across workspaces. */
export async function dueHolds(db: Db, now = new Date(), limit = 50) {
  const { rows } = await db.admin.query<{ workspace_id: string; id: string }>(
    `SELECT DISTINCT ON (workspace_id, coalesce(bundle_id, id)) workspace_id, id FROM approval_requests
     WHERE status = 'pending' AND hold_until IS NOT NULL AND hold_until <= $1
     ORDER BY workspace_id, coalesce(bundle_id, id), id LIMIT $2`,
    [now, limit],
  );
  return rows;
}
