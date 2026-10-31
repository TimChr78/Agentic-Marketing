import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { activeMandate } from '@agentic-marketing/artifacts';
import type { Services } from '@agentic-marketing/commands';
import { newId } from '@agentic-marketing/core';
import { type AgentGuardState, type Db, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { and, desc, eq, sql } from 'drizzle-orm';

// The guardian (ADR-0016, #253): a scheduler job that watches every active agent with a mandate,
// without a person. It reads the agent's own ledger and its mandate's guardrails and, when
// something is off, caps the agent's levels (or pauses it), turns its pending holds into ordinary
// approvals, records an episode with the evidence and tells the sponsor. A person clears it with
// agents.clearGuard (and resumes a paused agent with agents.resume).

export type GuardianKind = 'guardrail' | 'anomaly' | 'probing' | 'loop' | 'errors';
type GuardianAction = 'cap' | 'hold' | 'pause';

/** Thresholds, exported so tests and docs agree with the code. */
export const GUARDIAN = {
  /** A send reaching more than this many times the agent's median send is an anomaly. */
  sendSizeFactor: 3,
  /** Prior sends needed before a median means anything. */
  minPriorSends: 3,
  /** Changes in one hour that count as a burst. */
  burstPerHour: 30,
  /** Refusals in one hour that count as probing. */
  probingPerHour: 10,
  /** Changes to the same target in one hour that count as a loop. */
  loopPerHour: 6,
  /** Failed actions in one hour, when also at least half of its actions, that count as rising errors. */
  errorsPerHour: 5,
} as const;

interface Finding {
  kind: GuardianKind;
  action: GuardianAction;
  reason: string;
  evidence: Record<string, unknown>;
}

/** What each action does to the agent's levels: cap every class, or hold irreversible ones. */
const CAPS: Record<Exclude<GuardianAction, 'pause'>, { cap: number; irreversibleCap?: number }> = {
  cap: { cap: 1 },
  hold: { cap: 4, irreversibleCap: 2 },
};

export interface GuardianDeps extends NotifyDeps {
  db: Db;
  services: Services;
}

export interface GuardianSummary {
  checked: number;
  episodes: number;
}

const HOUR_MS = 3_600_000;
const fmt = (n: number) => n.toLocaleString('en-US');

/** When the guardian last acted for this kind and a person cleared it; null if it never acted. Undefined: still open. */
async function lastCleared(tx: Tx, agentId: string, kind: GuardianKind): Promise<Date | null | undefined> {
  const [e] = await tx
    .select({ clearedAt: schema.guardianEvents.clearedAt })
    .from(schema.guardianEvents)
    .where(and(eq(schema.guardianEvents.agentId, agentId), eq(schema.guardianEvents.kind, kind)))
    .orderBy(desc(schema.guardianEvents.at))
    .limit(1);
  if (!e) return null;
  return e.clearedAt ?? undefined;
}

/** The ledger rows of the last hour after `after` (a person's clearing), for the checks below. */
async function recentActions(tx: Tx, agentId: string, now: Date, after: Date | null) {
  const since = new Date(Math.max(now.getTime() - HOUR_MS, after?.getTime() ?? 0));
  return tx
    .select({
      id: schema.agentActions.id,
      actionClass: schema.agentActions.actionClass,
      decision: schema.agentActions.decision,
      ok: schema.agentActions.ok,
      target: schema.agentActions.target,
      people: sql<number | null>`(${schema.agentActions.impact}->>'people')::int`,
    })
    .from(schema.agentActions)
    .where(
      and(eq(schema.agentActions.agentId, agentId), sql`${schema.agentActions.at} > ${since}`, sql`${schema.agentActions.at} <= ${now}`),
    );
}

/** Everything that is off for one agent; each kind only once until a person clears it. */
async function findings(tx: Tx, deps: GuardianDeps, workspaceId: string, agentId: string, now: Date): Promise<Finding[]> {
  const mandate = await activeMandate(tx, agentId, now);
  if (!mandate) return [];
  const out: Finding[] = [];
  const open = new Map<GuardianKind, Date | null>();
  for (const kind of ['guardrail', 'anomaly', 'probing', 'loop', 'errors'] as const) {
    const cleared = await lastCleared(tx, agentId, kind);
    if (cleared !== undefined) open.set(kind, cleared);
  }

  // Guardrails, continuously: rates arrive after a send, so a breach can show long after the check before it.
  if (open.has('guardrail') && deps.services.mandateGuardrails) {
    const cleared = open.get('guardrail');
    // After a person cleared a guardrail episode, only a new send can trigger it again.
    const sentSince = cleared
      ? (
          await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.agentActions)
            .where(
              and(
                eq(schema.agentActions.agentId, agentId),
                sql`${schema.agentActions.actionClass} IN ('send.broadcast', 'send.direct')`,
                sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
                sql`${schema.agentActions.at} > ${cleared}`,
              ),
            )
        )[0].n > 0
      : true;
    const breach = sentSince ? await deps.services.mandateGuardrails(tx, workspaceId, agentId, mandate.view) : null;
    if (breach) out.push({ kind: 'guardrail', action: 'cap', reason: breach, evidence: { mandate: mandate.view.id } });
  }

  const recent = async (kind: GuardianKind) => recentActions(tx, agentId, now, open.get(kind) ?? null);

  if (open.has('probing')) {
    const denied = (await recent('probing')).filter((a) => a.decision === 'deny');
    if (denied.length >= GUARDIAN.probingPerHour)
      out.push({
        kind: 'probing',
        action: 'pause',
        reason: `${fmt(denied.length)} of this agent’s requests were refused in the last hour: it may be probing its limits.`,
        evidence: { refused: denied.length, actions: denied.slice(-20).map((a) => a.id) },
      });
  }

  if (open.has('loop')) {
    const byTarget = new Map<string, number[]>();
    for (const a of await recent('loop'))
      if (a.target && a.ok && (a.decision === 'allow' || a.decision === 'hold') && a.actionClass !== 'draft')
        byTarget.set(a.target, [...(byTarget.get(a.target) ?? []), a.id]);
    const [target, ids] = [...byTarget].sort((x, y) => y[1].length - x[1].length)[0] ?? [];
    if (target && ids.length >= GUARDIAN.loopPerHour)
      out.push({
        kind: 'loop',
        action: 'pause',
        reason: `This agent changed ${target} ${fmt(ids.length)} times in the last hour: it may be in a loop.`,
        evidence: { target, changes: ids.length, actions: ids.slice(-20) },
      });
  }

  if (open.has('errors')) {
    const actions = await recent('errors');
    const failed = actions.filter((a) => !a.ok);
    if (failed.length >= GUARDIAN.errorsPerHour && failed.length * 2 >= actions.length)
      out.push({
        kind: 'errors',
        action: 'cap',
        reason: `${fmt(failed.length)} of this agent’s ${fmt(actions.length)} actions in the last hour failed.`,
        evidence: { failed: failed.length, total: actions.length, actions: failed.slice(-20).map((a) => a.id) },
      });
  }

  if (open.has('anomaly')) {
    const actions = await recent('anomaly');
    const changes = actions.filter((a) => a.ok && (a.decision === 'allow' || a.decision === 'hold') && a.actionClass !== 'draft');
    if (changes.length >= GUARDIAN.burstPerHour)
      out.push({
        kind: 'anomaly',
        action: 'hold',
        reason: `This agent made ${fmt(changes.length)} changes in the last hour, far more than usual.`,
        evidence: { changes: changes.length },
      });
    else {
      const sends = changes.filter((a) => a.actionClass === 'send.broadcast' && a.people !== null);
      const largest = sends.sort((x, y) => (y.people ?? 0) - (x.people ?? 0))[0];
      if (largest) {
        // The agent's own history: its sends before this hour.
        const prior = await tx
          .select({ people: sql<number>`(${schema.agentActions.impact}->>'people')::int` })
          .from(schema.agentActions)
          .where(
            and(
              eq(schema.agentActions.agentId, agentId),
              eq(schema.agentActions.actionClass, 'send.broadcast'),
              sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
              eq(schema.agentActions.ok, true),
              sql`${schema.agentActions.id} < ${Math.min(...sends.map((s) => s.id))}`,
              sql`${schema.agentActions.impact} ? 'people'`,
            ),
          )
          .orderBy(desc(schema.agentActions.id))
          .limit(50);
        if (prior.length >= GUARDIAN.minPriorSends) {
          const sorted = prior.map((p) => p.people).sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          if ((largest.people ?? 0) > GUARDIAN.sendSizeFactor * Math.max(median, 1))
            out.push({
              kind: 'anomaly',
              action: 'hold',
              reason: `This agent’s send reached ${fmt(largest.people ?? 0)} people, more than ${GUARDIAN.sendSizeFactor}× its usual ${fmt(median)}.`,
              evidence: { action: largest.id, people: largest.people, median, priorSends: prior.length },
            });
        }
      }
    }
  }
  return out;
}

/** Turns the agent's pending holds into ordinary approvals, so nothing it asked for runs by itself. */
async function suspendHolds(tx: Tx, agentId: string, reason: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE approval_requests ar SET hold_until = NULL,
      note = ar.note || ${`\n\nThe guardian suspended this hold: ${reason} A person decides now.`}
    WHERE ar.status = 'pending' AND ar.hold_until IS NOT NULL AND ar.requested_by_type = 'agent'
      AND EXISTS (
        SELECT 1 FROM agent_credentials c WHERE c.agent_id = ${agentId} AND (
          (c.kind = 'api_token' AND ar.requested_by_client = 'token:' || c.credential_id)
          OR (c.kind = 'hosted' AND ar.requested_by_client = 'hosted:' || c.credential_id)
          OR (c.kind = 'oauth_client' AND ar.requested_by_client = c.credential_id)))
    RETURNING ar.id`);
  return rows.rows.length;
}

/** Applies one finding: the cap or the pause, suspended holds and the episode. Returns the episode id. */
async function act(tx: Tx, agent: typeof schema.agents.$inferSelect, f: Finding, now: Date): Promise<{ id: string; suspended: number }> {
  const id = newId('gde');
  const suspended = await suspendHolds(tx, agent.id, f.reason);
  if (f.action === 'pause') {
    await tx
      .update(schema.agents)
      .set({
        status: 'paused',
        statusReason: `The guardian paused it: ${f.reason}`,
        statusChangedBy: 'guardian',
        statusChangedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.agents.id, agent.id));
  }
  const add = f.action === 'pause' ? CAPS.cap : CAPS[f.action];
  const prev = agent.guard;
  const guard: AgentGuardState = {
    cap: Math.min(prev?.cap ?? 4, add.cap),
    ...(prev?.irreversibleCap !== undefined || add.irreversibleCap !== undefined
      ? { irreversibleCap: Math.min(prev?.irreversibleCap ?? 4, add.irreversibleCap ?? 4) }
      : {}),
    reason: prev ? `${prev.reason} ${f.reason}` : `The guardian limited this agent: ${f.reason}`,
    since: prev?.since ?? now.toISOString(),
    episodeIds: [...(prev?.episodeIds ?? []), id],
  };
  await tx.update(schema.agents).set({ guard, updatedAt: now }).where(eq(schema.agents.id, agent.id));
  agent.guard = guard;
  await tx.insert(schema.guardianEvents).values({
    workspaceId: agent.workspaceId,
    id,
    agentId: agent.id,
    kind: f.kind,
    action: f.action,
    reason: f.reason,
    evidence: f.evidence,
    suspendedHolds: suspended,
    at: now,
  });
  return { id, suspended };
}

const ACTION_TEXT: Record<GuardianAction, string> = {
  cap: 'Every change it makes now waits for a person.',
  hold: 'Its sends and other irreversible actions are now held for a veto window at most.',
  pause: 'It is paused: its credentials are refused until a person resumes it.',
};

async function notify(
  tx: Tx,
  deps: GuardianDeps,
  agent: typeof schema.agents.$inferSelect,
  done: (Finding & { id: string; suspended: number })[],
) {
  const mandate = await activeMandate(tx, agent.id).catch(() => null);
  const recipients = [...new Set([agent.sponsorUserId, ...(mandate?.content.escalation.userIds ?? [])])];
  const url = `${deps.publicUrl.replace(/\/$/, '')}/settings/agents/${encodeURIComponent(agent.id)}`;
  const lines = done.map((f) => `- ${f.reason} ${ACTION_TEXT[f.action]}`);
  const text = [
    `The guardian acted on the agent “${agent.name}”:`,
    '',
    ...lines,
    '',
    'Pending holds of this agent now wait for a person instead of running by themselves.',
    `Review the evidence and clear it on the agent page: ${url}`,
    '',
    'You receive this because you sponsor this agent or are an escalation target in its mandate.',
  ].join('\n');
  const esc = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>${esc(`The guardian acted on the agent “${agent.name}”:`)}</p><ul>${done.map((f) => `<li>${esc(`${f.reason} ${ACTION_TEXT[f.action]}`)}</li>`).join('')}</ul>
<p>Pending holds of this agent now wait for a person instead of running by themselves.</p>
<p><a href="${esc(url)}">Review the evidence and clear it</a></p></body></html>`;
  const subject = done.some((f) => f.action === 'pause') ? `Guardian paused “${agent.name}”` : `Guardian limited “${agent.name}”`;
  const results = await sendMemberEmails(
    tx,
    deps,
    agent.workspaceId,
    recipients.map((userId) => ({ userId, idempotencyKey: `guardian:${done.map((d) => d.id).join(',')}:${userId}`, subject, text, html })),
  );
  for (const r of results)
    if (r.status === 'failed') logger.warn({ agent: agent.id, user: r.userId, error: r.error }, 'guardian e-mail failed');
}

/** One round over every active agent with a mandate, in every workspace. */
export async function runGuardianOnce(deps: GuardianDeps, now = new Date()): Promise<GuardianSummary> {
  const summary: GuardianSummary = { checked: 0, episodes: 0 };
  const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM agents WHERE status = 'active' ORDER BY workspace_id, id`,
  );
  for (const { workspace_id: ws, id } of rows) {
    try {
      await deps.db.withWorkspace(ws, async (tx) => {
        // The same lock as the policy engine: a decision and the guardian never interleave.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-policy:${ws}:${id}`}, 0))`);
        const [agent] = await tx.select().from(schema.agents).where(eq(schema.agents.id, id));
        if (agent?.status !== 'active') return;
        summary.checked++;
        const found = await findings(tx, deps, ws, id, now);
        if (!found.length) return;
        const done: (Finding & { id: string; suspended: number })[] = [];
        for (const f of found) {
          done.push({ ...f, ...(await act(tx, agent, f, now)) });
          summary.episodes++;
        }
        logger.warn({ workspace: ws, agent: id, episodes: done.map((d) => ({ kind: d.kind, action: d.action })) }, 'guardian acted');
        await notify(tx, deps, agent, done).catch((err) => logger.warn({ err, agent: id }, 'guardian notification failed'));
      });
    } catch (err) {
      logger.warn({ err, workspace: ws, agent: id }, 'guardian check failed');
    }
  }
  return summary;
}

export async function runGuardian(deps: GuardianDeps, signal: AbortSignal, opts: { tickMs?: number } = {}) {
  const tickMs = opts.tickMs ?? 5 * 60_000;
  logger.info('scheduler role: agent guardian');
  while (!signal.aborted) {
    await runGuardianOnce(deps).catch((err) => logger.error({ err }, 'guardian round failed'));
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
