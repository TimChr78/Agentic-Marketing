import { HELD_RECHECK } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { type AgentEventType, type Db, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt } from 'drizzle-orm';

// Events for agents (#312; ADR-0016 §6): a scheduler job that derives what an agent's loop reacts
// to from what the platform already records, and delivers each event to the agents subscribed to
// it. A subscription with a webhook becomes a normal signed, retried webhook delivery; every
// event is also recorded for `agents.events`, the polling fallback. Events carry ids, a type, a
// time and a short summary, never personal data.

const MAX_PER_RUN = 500;
const SUMMARY_MAX = 500;

export interface AgentEventDeps {
  db: Db;
}

export interface AgentEventsSummary {
  /** Events recorded for an agent (one per subscription). */
  delivered: number;
  /** Webhook deliveries queued. */
  webhooks: number;
}

export interface DerivedEvent {
  key: string;
  type: AgentEventType;
  /** The agent the event is about; null for workspace-wide events (an alert, an experiment). */
  agentId: string | null;
  at: Date;
  summary: string;
  subject: Record<string, unknown>;
}

const clip = (text: string) => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text);

/** Every key in the filter must match the event's subject; an array matches any of its values. */
function matchesFilter(filter: Record<string, string | string[]>, subject: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, want]) => {
    const got = subject[key];
    const values = Array.isArray(want) ? want : [want];
    if (Array.isArray(got)) return got.some((value) => values.includes(String(value)));
    return got !== undefined && values.includes(String(got));
  });
}

/** The agent behind an approval's `requested_by_client`: `token:<id>`, `hosted:<agent id>` or an OAuth client id. */
function credentialKey(client: string): string {
  if (client.startsWith('token:')) return `api_token:${client.slice('token:'.length)}`;
  if (client.startsWith('hosted:')) return `hosted:${client.slice('hosted:'.length)}`;
  return `oauth_client:${client}`;
}

async function agentByCredential(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      kind: schema.agentCredentials.kind,
      credentialId: schema.agentCredentials.credentialId,
      agentId: schema.agentCredentials.agentId,
    })
    .from(schema.agentCredentials);
  return new Map(rows.map((row) => [`${row.kind}:${row.credentialId}`, row.agentId]));
}

interface Derived {
  events: DerivedEvent[];
  next: {
    lastActionId: number;
    lastApprovalAt: Date | null;
    lastGuardianAt: Date | null;
    lastAlertAt: Date | null;
    lastExperimentAt: Date | null;
  };
}

const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** Everything that happened since the cursor, from the ledger, approvals, the guardian, alerts and subject tests. */
async function derive(tx: Tx, workspaceId: string, cursor: typeof schema.agentEventCursor.$inferSelect): Promise<Derived> {
  const events: DerivedEvent[] = [];
  const agents = await agentByCredential(tx);

  // Approvals a person decided (or the hold runner did), including holds that were vetoed or ran.
  const approvals = await tx
    .select()
    .from(schema.approvalRequests)
    .where(
      and(
        eq(schema.approvalRequests.workspaceId, workspaceId),
        isNotNull(schema.approvalRequests.decidedAt),
        inArray(schema.approvalRequests.status, ['approved', 'rejected', 'withdrawn']),
        gte(schema.approvalRequests.decidedAt, cursor.lastApprovalAt ?? new Date(0)),
      ),
    )
    .orderBy(asc(schema.approvalRequests.decidedAt))
    .limit(MAX_PER_RUN);
  for (const row of approvals) {
    const at = row.decidedAt!;
    if (row.requestedByType !== 'agent' || !row.requestedByClient) continue;
    const agentId = agents.get(credentialKey(row.requestedByClient));
    if (!agentId) continue;
    const subject = { approvalId: row.id, artifactId: row.artifactId, version: row.version, decision: row.status };
    events.push({
      key: `approval:${row.id}:${row.status}`,
      type: 'approval.decided',
      agentId,
      at,
      summary: `Approval ${row.id} for ${row.artifactId} v${row.version} was ${row.status}.`,
      subject,
    });
    if (row.holdUntil) {
      if (row.status === 'rejected')
        events.push({
          key: `hold:${row.id}:vetoed`,
          type: 'hold.vetoed',
          agentId,
          at,
          summary: `A person vetoed the held change to ${row.artifactId} v${row.version}.`,
          subject,
        });
      else if (row.status === 'approved')
        events.push({
          key: `hold:${row.id}:ran`,
          type: 'hold.ran',
          agentId,
          at,
          summary: `The held change to ${row.artifactId} v${row.version} ran after its veto window.`,
          subject,
        });
    }
  }

  // A held change whose veto window ended and that now needs a person (the hold runner's recheck).
  const asks = await tx
    .select()
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.workspaceId, workspaceId),
        gt(schema.agentActions.id, cursor.lastActionId),
        eq(schema.agentActions.command, HELD_RECHECK),
        eq(schema.agentActions.decision, 'ask'),
      ),
    )
    .orderBy(asc(schema.agentActions.id))
    .limit(MAX_PER_RUN);
  for (const row of asks) {
    events.push({
      key: `action:${row.id}`,
      type: 'hold.needs_person',
      agentId: row.agentId,
      at: row.at,
      summary: clip(`A held ${row.actionClass} change needs a person: ${row.reasons.filter(Boolean).join(' ')}`),
      subject: { actionId: row.id, command: row.command, actionClass: row.actionClass, target: row.target },
    });
  }

  // Guardian episodes; a guardrail breach is also its own event so an agent can react to the metric.
  const episodes = await tx
    .select()
    .from(schema.guardianEvents)
    .where(and(eq(schema.guardianEvents.workspaceId, workspaceId), gte(schema.guardianEvents.at, cursor.lastGuardianAt ?? new Date(0))))
    .orderBy(asc(schema.guardianEvents.at))
    .limit(MAX_PER_RUN);
  for (const row of episodes) {
    const subject = { episodeId: row.id, kind: row.kind, action: row.action, suspendedHolds: row.suspendedHolds };
    events.push({
      key: `guardian:${row.id}`,
      type: 'guardian.episode',
      agentId: row.agentId,
      at: row.at,
      summary: clip(`The guardian ${row.action === 'pause' ? 'paused' : 'limited'} this agent (${row.kind}): ${row.reason}`),
      subject,
    });
    if (row.kind === 'guardrail')
      events.push({
        key: `guardrail:${row.id}`,
        type: 'guardrail.breach',
        agentId: row.agentId,
        at: row.at,
        summary: clip(`A guardrail was breached: ${row.reason}`),
        subject,
      });
  }

  // Alerts that fired (the open row is the episode; resolved updates it, it does not fire again).
  const alerts = await tx
    .select({
      id: schema.alertEvents.id,
      ruleId: schema.alertEvents.ruleId,
      value: schema.alertEvents.value,
      threshold: schema.alertEvents.threshold,
      window: schema.alertEvents.window,
      firedAt: schema.alertEvents.firedAt,
      name: schema.alertRules.name,
    })
    .from(schema.alertEvents)
    .innerJoin(
      schema.alertRules,
      and(eq(schema.alertRules.workspaceId, schema.alertEvents.workspaceId), eq(schema.alertRules.id, schema.alertEvents.ruleId)),
    )
    .where(
      and(
        eq(schema.alertEvents.workspaceId, workspaceId),
        eq(schema.alertEvents.state, 'firing'),
        gte(schema.alertEvents.firedAt, cursor.lastAlertAt ?? new Date(0)),
      ),
    )
    .orderBy(asc(schema.alertEvents.firedAt))
    .limit(MAX_PER_RUN);
  for (const row of alerts)
    events.push({
      key: `alert:${row.id}`,
      type: 'alert.fired',
      agentId: null,
      at: row.firedAt,
      summary: clip(`Alert “${row.name}” fired: ${row.value} against ${row.threshold} over ${row.window}.`),
      subject: { alertId: row.id, ruleId: row.ruleId, value: row.value, threshold: row.threshold, window: row.window },
    });

  // A subject test whose winner was decided. The verdict is stored by the broadcast runner; ties and
  // too little data are not an experiment reaching significance.
  const tests = await tx
    .select()
    .from(schema.broadcastTests)
    .where(
      and(
        eq(schema.broadcastTests.workspaceId, workspaceId),
        eq(schema.broadcastTests.state, 'winner_sent'),
        isNotNull(schema.broadcastTests.decidedAt),
        gte(schema.broadcastTests.decidedAt, cursor.lastExperimentAt ?? new Date(0)),
      ),
    )
    .orderBy(asc(schema.broadcastTests.decidedAt))
    .limit(MAX_PER_RUN);
  for (const row of tests) {
    if (!row.decidedAt || !row.reason || row.reason.startsWith('no clear winner')) continue;
    events.push({
      key: `experiment:${row.broadcastId}:${row.decidedAt.toISOString()}`,
      type: 'experiment.significant',
      agentId: null,
      at: row.decidedAt,
      summary: clip(`Subject test on ${row.broadcastId} reached a verdict: ${row.reason}`),
      subject: { broadcastId: row.broadcastId, winner: row.winner, metric: row.metric },
    });
  }

  return {
    events,
    next: {
      lastActionId: asks.reduce((max, row) => Math.max(max, row.id), cursor.lastActionId),
      lastApprovalAt: approvals.reduce<Date | null>((max, row) => later(max, row.decidedAt), cursor.lastApprovalAt ?? null),
      lastGuardianAt: episodes.reduce<Date | null>((max, row) => later(max, row.at), cursor.lastGuardianAt ?? null),
      lastAlertAt: alerts.reduce<Date | null>((max, row) => later(max, row.firedAt), cursor.lastAlertAt ?? null),
      lastExperimentAt: tests.reduce<Date | null>((max, row) => later(max, row.decidedAt), cursor.lastExperimentAt ?? null),
    },
  };
}

async function sweepWorkspace(deps: AgentEventDeps, workspaceId: string, now: Date): Promise<AgentEventsSummary> {
  return deps.db.withWorkspace(workspaceId, async (tx) => {
    let [cursor] = await tx.select().from(schema.agentEventCursor).where(eq(schema.agentEventCursor.workspaceId, workspaceId));
    const subscriptions = await tx.select().from(schema.agentSubscriptions);
    if (!cursor) {
      // Start where the earliest subscription starts: an upgraded workspace has nothing to replay,
      // and a new subscriber hears what happens from then on, not the workspace's history.
      const since = subscriptions.length ? new Date(Math.min(...subscriptions.map((s) => s.createdAt.getTime()))) : now;
      const [already] = subscriptions.length
        ? await tx
            .select({ id: schema.agentActions.id })
            .from(schema.agentActions)
            .where(and(eq(schema.agentActions.workspaceId, workspaceId), lt(schema.agentActions.at, since)))
            .orderBy(desc(schema.agentActions.id))
            .limit(1)
        : [];
      await tx
        .insert(schema.agentEventCursor)
        .values({
          workspaceId,
          lastActionId: already?.id ?? 0,
          lastApprovalAt: since,
          lastGuardianAt: since,
          lastAlertAt: since,
          lastExperimentAt: since,
        })
        .onConflictDoNothing();
      [cursor] = await tx.select().from(schema.agentEventCursor).where(eq(schema.agentEventCursor.workspaceId, workspaceId));
    }
    if (!cursor) return { delivered: 0, webhooks: 0 };

    const { events, next } = await derive(tx, workspaceId, cursor);
    let delivered = 0;
    let webhooks = 0;
    if (subscriptions.length)
      for (const event of events)
        for (const sub of subscriptions) {
          if (!sub.eventTypes.includes(event.type)) continue;
          if (event.agentId && sub.agentId !== event.agentId) continue;
          if (event.at < sub.createdAt) continue;
          if (!matchesFilter(sub.filter, event.subject)) continue;
          const [stored] = await tx
            .insert(schema.agentEvents)
            .values({
              workspaceId,
              agentId: sub.agentId,
              subscriptionId: sub.id,
              type: event.type,
              eventKey: event.key,
              summary: event.summary,
              subject: event.subject,
              at: event.at,
            })
            .onConflictDoNothing()
            .returning({ id: schema.agentEvents.id });
          if (!stored) continue;
          delivered++;
          if (!sub.webhookId) continue;
          await tx
            .insert(schema.deliveries)
            .values({
              workspaceId,
              id: newId('dlv'),
              kind: 'webhook',
              targetId: sub.webhookId,
              payload: {
                type: 'agent.event',
                timestamp: event.at.toISOString(),
                data: {
                  event: {
                    id: stored.id,
                    agentId: sub.agentId,
                    type: event.type,
                    at: event.at.toISOString(),
                    summary: event.summary,
                    subject: event.subject,
                  },
                },
              },
              status: 'pending',
              idempotencyKey: `agent-event:${sub.id}:${event.key}`,
            })
            .onConflictDoNothing();
          webhooks++;
        }

    // Advance only over what was read. A re-derived row at the same timestamp is harmless: the
    // subscription event key makes it silent.
    await tx
      .update(schema.agentEventCursor)
      .set({
        lastActionId: next.lastActionId,
        lastApprovalAt: next.lastApprovalAt,
        lastGuardianAt: next.lastGuardianAt,
        lastAlertAt: next.lastAlertAt,
        lastExperimentAt: next.lastExperimentAt,
      })
      .where(eq(schema.agentEventCursor.workspaceId, workspaceId));
    return { delivered, webhooks };
  });
}

/** One sweep over every workspace with an agent. The scheduler calls this; tests pass a clock. */
export async function runAgentEventsOnce(deps: AgentEventDeps, now = new Date()): Promise<AgentEventsSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>('SELECT DISTINCT workspace_id FROM agents');
  const total = { delivered: 0, webhooks: 0 };
  for (const { workspace_id: workspaceId } of rows) {
    try {
      const out = await sweepWorkspace(deps, workspaceId, now);
      total.delivered += out.delivered;
      total.webhooks += out.webhooks;
    } catch (err) {
      logger.error({ err, workspaceId }, 'agent event round failed');
    }
  }
  return total;
}

export interface AgentEventOptions {
  tickMs?: number;
}

/** The scheduler job: every five minutes by default. */
export async function runAgentEvents(deps: AgentEventDeps, signal: AbortSignal, opts: AgentEventOptions = {}) {
  const tickMs = opts.tickMs ?? 5 * 60_000;
  logger.info('scheduler role: agent event subscriptions');
  while (!signal.aborted) {
    try {
      await runAgentEventsOnce(deps);
    } catch (err) {
      logger.error({ err }, 'agent event round failed');
    }
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
