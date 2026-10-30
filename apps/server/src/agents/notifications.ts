import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { activeMandate, artifactTypes } from '@agentic-marketing/artifacts';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { and, asc, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';

// Sponsor notifications and agent digests (#226, ADR-0016). The scheduler reads the agent action
// ledger from a stored cursor: a hold, a guardrail/limit escalation or a refusal is e-mailed to the
// sponsor and the mandate's escalation targets, batched per agent so a burst is one message. Allows
// stay out of these e-mails; they are summarised once a day per sponsor. An active mandate that
// ends within three days is announced once.

const DAY_MS = 86_400_000;
const DIGEST_WINDOW_MS = DAY_MS;
const EXPIRY_WINDOW_MS = 3 * DAY_MS;
const MAX_ACTIONS_PER_RUN = 500;

export interface AgentNotificationDeps extends NotifyDeps {
  db: Db;
}

export interface AgentNotificationSummary {
  /** E-mails sent for held/asked/refused actions. */
  events: number;
  /** Daily digest e-mails sent. */
  digests: number;
  /** Mandate expiry e-mails sent. */
  expiries: number;
}

const emptySummary = (): AgentNotificationSummary => ({ events: 0, digests: 0, expiries: 0 });

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const baseUrl = (publicUrl: string) => publicUrl.replace(/\/$/, '');
const agentUrl = (publicUrl: string, agentId: string) => `${baseUrl(publicUrl)}/settings/agents/${encodeURIComponent(agentId)}`;
const approvalUrl = (publicUrl: string, approvalId: string) => `${baseUrl(publicUrl)}/approvals/${encodeURIComponent(approvalId)}`;

const actionKey = (action: typeof schema.agentActions.$inferSelect) => `${action.id}:${action.command}`;

function impactLine(impact: Record<string, unknown>): string {
  const skip = new Set(['actionClass', 'reversible', 'needsPerson', 'touches', 'summary']);
  const parts = Object.entries(impact)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  return parts.join(', ');
}

function actionLine(action: typeof schema.agentActions.$inferSelect): string {
  const bits = [`${action.command} (${action.actionClass})`];
  if (action.intent) bits.push(`intent: ${action.intent}`);
  const impact = impactLine(action.impact);
  if (impact) bits.push(impact);
  const reasons = action.reasons?.filter(Boolean) ?? [];
  if (reasons.length) bits.push(reasons.join(' '));
  if (action.error) bits.push(`error: ${action.error}`);
  return bits.join(' · ');
}

type ActionRow = typeof schema.agentActions.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;

interface PendingApproval {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  holdUntil: Date | null;
}

/** The approval a held or escalated action created: the newest request for the same artifact(s). */
async function approvalForAction(
  tx: Tx,
  action: ActionRow,
  opts: { pendingOnly?: boolean; holdOnly?: boolean } = {},
): Promise<PendingApproval | null> {
  if (!action.target) return null;
  const [row] = await tx
    .select({
      id: schema.approvalRequests.id,
      status: schema.approvalRequests.status,
      holdUntil: schema.approvalRequests.holdUntil,
    })
    .from(schema.approvalRequests)
    .where(
      and(
        inArray(schema.approvalRequests.artifactId, action.target.split(',')),
        opts.pendingOnly ? eq(schema.approvalRequests.status, 'pending') : undefined,
        opts.holdOnly ? isNotNull(schema.approvalRequests.holdUntil) : undefined,
      ),
    )
    .orderBy(desc(schema.approvalRequests.createdAt))
    .limit(1);
  return row ?? null;
}

interface EventLine {
  action: ActionRow;
  approval: PendingApproval | null;
}

function eventEmail(deps: AgentNotificationDeps, agent: AgentRow, lines: EventLine[]) {
  const holds = lines.filter((l) => l.action.decision === 'hold');
  const subject =
    lines.length === 1
      ? holds.length
        ? `Held: “${agent.name}” is waiting for your review`
        : lines[0].action.decision === 'deny'
          ? `Refused: “${agent.name}” was stopped`
          : `Needs you: “${agent.name}”`
      : `“${agent.name}”: ${lines.length} changes need your attention`;

  const text: string[] = [
    lines.length === 1
      ? `The agent “${agent.name}” has a change that needs a person.`
      : `The agent “${agent.name}” has ${lines.length} changes that need a person.`,
    '',
  ];
  for (const [i, line] of lines.entries()) {
    const a = line.action;
    const what = a.decision === 'hold' ? 'Held' : a.decision === 'deny' ? 'Refused' : 'Needs a person';
    text.push(`${i + 1}. ${what}: ${actionLine(a)}`);
    if (a.decision === 'hold') {
      const runsAt = line.approval?.holdUntil;
      text.push(
        runsAt
          ? `   It runs at ${runsAt.toISOString()} unless you reject it.`
          : '   It runs when its veto window ends unless you reject it.',
      );
    }
    text.push(
      line.approval
        ? `   Review: ${approvalUrl(deps.publicUrl, line.approval.id)}`
        : `   Open the agent: ${agentUrl(deps.publicUrl, agent.id)}`,
    );
  }
  text.push('', `Agent: ${agentUrl(deps.publicUrl, agent.id)}`);
  text.push('', 'You receive this because you sponsor this agent or are an escalation target in its mandate.');

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>${escapeHtml(lines.length === 1 ? `The agent “${agent.name}” has a change that needs a person.` : `The agent “${agent.name}” has ${lines.length} changes that need a person.`)}</p>
<ol>${lines
    .map((line) => {
      const a = line.action;
      const what = a.decision === 'hold' ? 'Held' : a.decision === 'deny' ? 'Refused' : 'Needs a person';
      const runs =
        a.decision === 'hold'
          ? `<br/><em>${escapeHtml(line.approval?.holdUntil ? `It runs at ${line.approval.holdUntil.toISOString()} unless you reject it.` : 'It runs when its veto window ends unless you reject it.')}</em>`
          : '';
      const link = line.approval
        ? `<br/><a href="${escapeHtml(approvalUrl(deps.publicUrl, line.approval.id))}">Review the change</a>`
        : `<br/><a href="${escapeHtml(agentUrl(deps.publicUrl, agent.id))}">Open the agent</a>`;
      return `<li><strong>${escapeHtml(what)}:</strong> ${escapeHtml(actionLine(a))}${runs}${link}</li>`;
    })
    .join('')}</ol>
<p><a href="${escapeHtml(agentUrl(deps.publicUrl, agent.id))}">Agent settings</a></p>
<p style="color:#777;font-size:12px">You receive this because you sponsor this agent or are an escalation target in its mandate.</p>
</body></html>`;

  return { subject, text: text.join('\n'), html };
}

async function notifyEvents(deps: AgentNotificationDeps, tx: Tx, workspaceId: string, actions: ActionRow[], now: Date): Promise<number> {
  const byAgent = new Map<string, ActionRow[]>();
  for (const action of actions) {
    if (action.actionClass === 'draft') continue;
    if (action.decision !== 'hold' && action.decision !== 'ask' && action.decision !== 'deny') continue;
    byAgent.set(action.agentId, [...(byAgent.get(action.agentId) ?? []), action]);
  }
  let sent = 0;
  for (const [agentId, rows] of byAgent) {
    const [agent] = await tx.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!agent) continue;
    const mandate = await activeMandate(tx, agentId, now);
    const recipients = [...new Set([agent.sponsorUserId, ...(mandate?.content.escalation.userIds ?? [])])];
    if (!recipients.length) continue;
    const lines: EventLine[] = [];
    for (const action of rows) {
      const approval =
        action.decision === 'hold'
          ? await approvalForAction(tx, action, { pendingOnly: true, holdOnly: true })
          : action.decision === 'ask'
            ? await approvalForAction(tx, action, { pendingOnly: true })
            : null;
      lines.push({ action, approval });
    }
    const batchKey = `${rows[0].id}-${rows.at(-1)!.id}`;
    const content = eventEmail(deps, agent, lines);
    const results = await sendMemberEmails(
      tx,
      deps,
      workspaceId,
      recipients.map((userId) => ({
        userId,
        idempotencyKey: `agent-event:${workspaceId}:${agentId}:${batchKey}:${userId}`,
        ...content,
        data: { agent: { id: agent.id, name: agent.name }, actions: rows.map(actionKey) },
      })),
    );
    sent += results.filter((r) => r.status === 'sent').length;
  }
  return sent;
}

interface AgentDigest {
  agent: AgentRow;
  counts: Record<'allow' | 'hold' | 'ask' | 'deny', number>;
  autonomous: ActionRow[];
  holds: { action: ActionRow; approval: PendingApproval | null }[];
  refusals: ActionRow[];
}

function holdOutcome(approval: PendingApproval | null): string {
  if (!approval) return 'waiting for a person since its veto window was not recorded';
  if (approval.status === 'approved') return 'ran after its veto window';
  if (approval.status === 'rejected') return 'vetoed by a person';
  if (approval.status === 'withdrawn') return 'withdrawn before it ran';
  return 'still waiting for its veto window';
}

function digestEmail(publicUrl: string, digests: AgentDigest[]) {
  const subject = digests.length === 1 ? `Daily agent digest: “${digests[0].agent.name}”` : `Daily agent digest: ${digests.length} agents`;
  const text: string[] = ['What your agents did in the last 24 hours.', ''];
  for (const d of digests) {
    text.push(`Agent: ${d.agent.name}`);
    text.push(`Changes: ${d.counts.allow} allowed, ${d.counts.hold} held, ${d.counts.ask} sent to a person, ${d.counts.deny} refused.`);
    if (d.autonomous.length) {
      text.push('Ran autonomously:');
      for (const a of d.autonomous) text.push(`- ${actionLine(a)}`);
    }
    if (d.holds.length) {
      text.push('Holds:');
      for (const h of d.holds) text.push(`- ${holdOutcome(h.approval)}: ${actionLine(h.action)}`);
    }
    if (d.refusals.length) {
      text.push('Refused:');
      for (const a of d.refusals) text.push(`- ${actionLine(a)}`);
    }
    text.push(`Agent: ${agentUrl(publicUrl, d.agent.id)}`, '');
  }
  text.push('You receive this daily digest as the sponsor of these agents.');

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>What your agents did in the last 24 hours.</p>
${digests
  .map((d) => {
    const list = (title: string, items: string[]) =>
      items.length ? `<p><strong>${escapeHtml(title)}</strong></p><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
    return `<h3>${escapeHtml(d.agent.name)}</h3>
<p>Changes: ${d.counts.allow} allowed, ${d.counts.hold} held, ${d.counts.ask} sent to a person, ${d.counts.deny} refused.</p>
${list('Ran autonomously', d.autonomous.map(actionLine))}
${list(
  'Holds',
  d.holds.map((h) => `${holdOutcome(h.approval)}: ${actionLine(h.action)}`),
)}
${list('Refused', d.refusals.map(actionLine))}
<p><a href="${escapeHtml(agentUrl(publicUrl, d.agent.id))}">Open ${escapeHtml(d.agent.name)}</a></p>`;
  })
  .join('')}
<p style="color:#777;font-size:12px">You receive this daily digest as the sponsor of these agents.</p>
</body></html>`;
  return { subject, text: text.join('\n'), html };
}

async function notifyDigest(
  deps: AgentNotificationDeps,
  tx: Tx,
  workspaceId: string,
  cursor: typeof schema.agentNotificationCursor.$inferSelect,
  now: Date,
): Promise<{ sent: number; at: Date | null }> {
  if (cursor.lastDigestAt && now.getTime() - cursor.lastDigestAt.getTime() < DAY_MS) return { sent: 0, at: null };
  const since = new Date(now.getTime() - DIGEST_WINDOW_MS);
  const recent = (
    await tx
      .select()
      .from(schema.agentActions)
      .where(and(eq(schema.agentActions.workspaceId, workspaceId), gt(schema.agentActions.at, since)))
      .orderBy(asc(schema.agentActions.id))
  ).filter((a) => a.actionClass !== 'draft');
  if (!recent.length) return { sent: 0, at: null };

  const byAgent = new Map<string, ActionRow[]>();
  for (const action of recent) byAgent.set(action.agentId, [...(byAgent.get(action.agentId) ?? []), action]);
  const agents = await tx
    .select()
    .from(schema.agents)
    .where(inArray(schema.agents.id, [...byAgent.keys()]));
  const digests: AgentDigest[] = [];
  for (const agent of agents) {
    const actions = byAgent.get(agent.id) ?? [];
    const counts = { allow: 0, hold: 0, ask: 0, deny: 0 };
    for (const a of actions) counts[a.decision]++;
    const holds: AgentDigest['holds'] = [];
    for (const action of actions.filter((a) => a.decision === 'hold'))
      holds.push({ action, approval: await approvalForAction(tx, action) });
    digests.push({
      agent,
      counts,
      autonomous: actions.filter((a) => a.decision === 'allow' && a.ok),
      holds,
      refusals: actions.filter((a) => a.decision === 'deny'),
    });
  }
  if (!digests.length) return { sent: 0, at: null };

  const bySponsor = new Map<string, AgentDigest[]>();
  for (const d of digests) bySponsor.set(d.agent.sponsorUserId, [...(bySponsor.get(d.agent.sponsorUserId) ?? []), d]);
  const day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const [sponsor, own] of bySponsor) {
    const content = digestEmail(deps.publicUrl, own);
    const results = await sendMemberEmails(tx, deps, workspaceId, [
      {
        userId: sponsor,
        idempotencyKey: `agent-digest:${workspaceId}:${sponsor}:${day}`,
        ...content,
        data: { digest: own.map((d) => ({ agentId: d.agent.id, counts: d.counts })) },
      },
    ]);
    sent += results.filter((r) => r.status === 'sent').length;
  }
  return { sent, at: sent ? now : null };
}

async function notifyExpiry(
  deps: AgentNotificationDeps,
  tx: Tx,
  workspaceId: string,
  cursor: typeof schema.agentNotificationCursor.$inferSelect,
  now: Date,
): Promise<{ sent: number; notified: Record<string, string> }> {
  const rows = await tx
    .select({
      artifactId: schema.artifacts.id,
      name: schema.artifacts.name,
      version: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
    })
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
      and(eq(schema.artifacts.type, 'agent_mandate'), eq(schema.artifacts.archived, false), isNotNull(schema.artifacts.publishedVersion)),
    );
  const notified = { ...cursor.expiryNotified };
  let sent = 0;
  for (const row of rows) {
    const parsed = artifactTypes.agent_mandate.content.safeParse(row.content);
    if (!parsed.success || !row.version) continue;
    const mandate = parsed.data;
    const until = new Date(mandate.validUntil);
    if (!(until > now) || until.getTime() > now.getTime() + EXPIRY_WINDOW_MS) continue;
    const key = `${row.artifactId}:${row.version}:${until.toISOString()}`;
    if (notified[key]) continue;
    const [agent] = await tx.select().from(schema.agents).where(eq(schema.agents.id, mandate.agent));
    if (!agent) continue;
    const days = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
    const url = agentUrl(deps.publicUrl, agent.id);
    const subject = `Mandate for “${agent.name}” expires in ${days} day${days === 1 ? '' : 's'}`;
    const text = [
      `The mandate “${row.name}” for the agent “${agent.name}” expires on ${until.toISOString()} (in ${days} day${days === 1 ? '' : 's'}).`,
      '',
      'Renew it in Settings → Agents, or the agent will fall back to the approval policy and stop acting autonomously.',
      '',
      `Open the agent: ${url}`,
    ].join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>The mandate <strong>${escapeHtml(row.name)}</strong> for the agent “${escapeHtml(agent.name)}” expires on ${escapeHtml(until.toISOString())} (in ${days} day${days === 1 ? '' : 's'}).</p>
<p>Renew it in Settings → Agents, or the agent will fall back to the approval policy and stop acting autonomously.</p>
<p><a href="${escapeHtml(url)}">Open the agent</a></p>
</body></html>`;
    const results = await sendMemberEmails(tx, deps, workspaceId, [
      {
        userId: agent.sponsorUserId,
        idempotencyKey: `agent-expiry:${workspaceId}:${agent.id}:${key}`,
        subject,
        text,
        html,
        data: { mandate: { artifactId: row.artifactId, version: row.version, validUntil: until.toISOString() } },
      },
    ]);
    if (results.some((r) => r.status === 'sent')) {
      notified[key] = now.toISOString();
      sent++;
    }
  }
  return { sent, notified };
}

async function notifyWorkspace(deps: AgentNotificationDeps, workspaceId: string, now: Date): Promise<AgentNotificationSummary> {
  return deps.db.withWorkspace(workspaceId, async (tx) => {
    await tx.insert(schema.agentNotificationCursor).values({ workspaceId }).onConflictDoNothing();
    const [cursor] = await tx
      .select()
      .from(schema.agentNotificationCursor)
      .where(eq(schema.agentNotificationCursor.workspaceId, workspaceId));
    if (!cursor) return emptySummary();

    const actions = await tx
      .select()
      .from(schema.agentActions)
      .where(and(eq(schema.agentActions.workspaceId, workspaceId), gt(schema.agentActions.id, cursor.lastActionId)))
      .orderBy(asc(schema.agentActions.id))
      .limit(MAX_ACTIONS_PER_RUN);
    const lastActionId = actions.at(-1)?.id ?? cursor.lastActionId;

    const events = await notifyEvents(deps, tx, workspaceId, actions, now);
    const digest = await notifyDigest(deps, tx, workspaceId, cursor, now);
    const expiry = await notifyExpiry(deps, tx, workspaceId, cursor, now);

    await tx
      .update(schema.agentNotificationCursor)
      .set({
        lastActionId,
        lastDigestAt: digest.at ?? cursor.lastDigestAt,
        expiryNotified: expiry.notified,
      })
      .where(eq(schema.agentNotificationCursor.workspaceId, workspaceId));

    return { events, digests: digest.sent, expiries: expiry.sent };
  });
}

/** One sweep over every workspace with an agent. The scheduler calls this; tests pass a clock. */
export async function runAgentNotificationsOnce(deps: AgentNotificationDeps, now = new Date()): Promise<AgentNotificationSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>('SELECT DISTINCT workspace_id FROM agents');
  const total = emptySummary();
  for (const { workspace_id: workspaceId } of rows) {
    try {
      const out = await notifyWorkspace(deps, workspaceId, now);
      total.events += out.events;
      total.digests += out.digests;
      total.expiries += out.expiries;
    } catch (err) {
      logger.error({ err, workspaceId }, 'agent notification round failed');
    }
  }
  return total;
}

export interface AgentNotificationOptions {
  tickMs?: number;
}

/** The scheduler job: every five minutes by default; digests and expiries are due once per day. */
export async function runAgentNotifications(deps: AgentNotificationDeps, signal: AbortSignal, opts: AgentNotificationOptions = {}) {
  const tickMs = opts.tickMs ?? 5 * 60_000;
  logger.info('scheduler role: agent notifications and digests');
  while (!signal.aborted) {
    try {
      await runAgentNotificationsOnce(deps);
    } catch (err) {
      logger.error({ err }, 'agent notification round failed');
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
