import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { activeMandate, artifactTypes } from '@agentic-marketing/artifacts';
import { sleep } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';

// Sponsor notifications and agent digests (#226, ADR-0016). The scheduler reads the agent action
// ledger from a stored cursor: a hold, a guardrail/limit escalation or a refusal is e-mailed to the
// sponsor and the mandate's escalation targets, batched per agent so a burst is one message. Allows
// stay out of these e-mails; they are summarised once a day per sponsor. An active mandate that
// ends within three days is announced once.

const DAY_MS = 86_400_000;
const DIGEST_WINDOW_MS = DAY_MS;
/** How far back an open digest window may reach: a window no one could close stays bounded (#1227). */
const MAX_DIGEST_LOOKBACK_MS = 7 * DAY_MS;
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
const agentUrl = (publicUrl: string, agentId: string) => `${baseUrl(publicUrl)}/work/agents/${encodeURIComponent(agentId)}`;
const approvalUrl = (publicUrl: string, approvalId: string) => `${baseUrl(publicUrl)}/approvals/${encodeURIComponent(approvalId)}`;

const actionKey = (action: typeof schema.agentActions.$inferSelect) => `${action.id}:${action.command}`;

function impactLine(impact: Record<string, unknown>): string {
  const skip = new Set(['actionClass', 'reversible', 'needsPerson', 'touches', 'summary', 'messageId']);
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

interface EventNotifications {
  /** E-mails delivered, one per recipient. */
  sent: number;
  /** The lowest action id whose notification could not be delivered to every recipient, or null. */
  firstFailedActionId: number | null;
}

const deliveryKey = (actionId: number, userId: string) => `${actionId}:${userId}`;

async function notifyEvents(
  deps: AgentNotificationDeps,
  tx: Tx,
  workspaceId: string,
  actions: ActionRow[],
  now: Date,
): Promise<EventNotifications> {
  const byAgent = new Map<string, ActionRow[]>();
  for (const action of actions) {
    if (action.actionClass === 'draft') continue;
    if (action.decision !== 'hold' && action.decision !== 'ask' && action.decision !== 'deny') continue;
    byAgent.set(action.agentId, [...(byAgent.get(action.agentId) ?? []), action]);
  }
  if (!byAgent.size) return { sent: 0, firstFailedActionId: null };
  const actionIds = [...byAgent.values()].flatMap((rows) => rows.map((row) => row.id));
  const delivered = new Set(
    (
      await tx
        .select({ actionId: schema.agentNotificationDeliveries.actionId, userId: schema.agentNotificationDeliveries.userId })
        .from(schema.agentNotificationDeliveries)
        .where(
          and(
            eq(schema.agentNotificationDeliveries.workspaceId, workspaceId),
            inArray(schema.agentNotificationDeliveries.actionId, actionIds),
          ),
        )
    ).map((row) => deliveryKey(row.actionId, row.userId)),
  );

  let sent = 0;
  let firstFailedActionId: number | null = null;
  for (const [agentId, rows] of byAgent) {
    const [agent] = await tx.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!agent) continue;
    const mandate = await activeMandate(tx, agentId, now);
    const recipients = [...new Set([agent.sponsorUserId, ...(mandate?.content.escalation.userIds ?? [])])];
    if (!recipients.length) continue;
    // A recipient who is not a workspace member can never be mailed: `sendMemberEmails` refuses
    // that address for good. Counting them as a failed recipient held the ledger cursor before
    // their first action until a mandate or sponsor changed, and once 500 newer rows followed it,
    // nobody was told about anything (#1234). They are not a recipient for this action, so the
    // cursor may pass it once the members were reached.
    const members = new Set(
      (
        await tx
          .select({ userId: schema.workspaceMembers.userId })
          .from(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(schema.workspaceMembers.userId, recipients)))
      ).map((row) => row.userId),
    );
    const reachable = recipients.filter((userId) => members.has(userId));
    if (!reachable.length) continue;
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

    // A recipient only hears about actions they have not received yet. The batch may shrink between
    // sweeps (a failure, a new action), and recording each delivered action keeps that retry from
    // re-sending what a different batch already covered for this recipient (#276).
    const pending = new Map<string, ActionRow[]>();
    for (const userId of reachable) {
      const rowsForUser = rows.filter((action) => !delivered.has(deliveryKey(action.id, userId)));
      if (rowsForUser.length) pending.set(userId, rowsForUser);
    }
    if (!pending.size) continue;

    const emails = [...pending].map(([userId, rowsForUser]) => {
      const ids = new Set(rowsForUser.map((action) => action.id));
      const content = eventEmail(
        deps,
        agent,
        lines.filter((line) => ids.has(line.action.id)),
      );
      return {
        userId,
        idempotencyKey: `agent-event:${workspaceId}:${agentId}:${rowsForUser.map((action) => action.id).join('-')}:${userId}`,
        ...content,
        data: { agent: { id: agent.id, name: agent.name }, actions: rowsForUser.map(actionKey) },
      };
    });
    const results = await sendMemberEmails(tx, deps, workspaceId, emails);
    const deliveries: { workspaceId: string; actionId: number; userId: string }[] = [];
    for (const result of results) {
      const rowsForUser = pending.get(result.userId) ?? [];
      if (result.status === 'sent') {
        for (const action of rowsForUser) deliveries.push({ workspaceId, actionId: action.id, userId: result.userId });
      } else {
        for (const action of rowsForUser)
          firstFailedActionId = firstFailedActionId === null ? action.id : Math.min(firstFailedActionId, action.id);
      }
    }
    if (deliveries.length) await tx.insert(schema.agentNotificationDeliveries).values(deliveries).onConflictDoNothing();
    sent += results.filter((r) => r.status === 'sent').length;
  }
  return { sent, firstFailedActionId };
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
  const text: string[] = ['What your agents did since your last digest.', ''];
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
<p>What your agents did since your last digest.</p>
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

/**
 * Where one sponsor's next digest begins. A row that failed or was suppressed leaves its window
 * open, so the next sweep retries that window with its own key (#1184); a row the provider accepted
 * closed it at the time it was sent, so the next digest starts there. One sponsor's window never
 * holds another's (#1227).
 */
interface DigestWindow {
  start: Date;
  open: boolean;
  key: string;
}

/** The window record of every sponsor who has had a digest in this workspace. */
async function digestWindows(tx: Tx, workspaceId: string): Promise<Map<string, DigestWindow>> {
  const prefix = `agent-digest:${workspaceId}:`;
  const { rows } = await tx.execute<{
    key: string;
    status: string;
    data: Record<string, unknown> | null;
    sent_at: Date | null;
    created_at: Date;
  }>(digestWindowsQuery(workspaceId));
  const windows = new Map<string, DigestWindow>();
  for (const row of rows) {
    // `agent-digest:<workspace>:<sponsor>:<window start>`; the ids never contain a colon, the
    // timestamp does. Rows written before the window key existed carry the UTC day instead.
    const rest = row.key.slice(prefix.length);
    // The sponsor id (a colon-free id) comes first; the rest is the timestamp, which has colons.
    const at = rest.indexOf(':');
    if (at <= 0) continue;
    const keyStart = new Date(rest.slice(at + 1));
    if (Number.isNaN(keyStart.getTime())) continue;
    const open = row.status === 'failed' || row.status === 'suppressed';
    // The row records the window it covered, so the next one begins where this ended rather than
    // at the wall clock of the send: a pass with a test clock, or a late one, stays consistent.
    const window = row.data?.digestWindow as { start?: string; end?: string } | undefined;
    // A row from before the window metadata existed has only the key, which is the window's
    // *start*. A sent row is the end of that window: using its start would rebuild the same key
    // and the sponsor would never get another digest. A failed row keeps its key for the retry.
    const recorded = open ? window?.start : (window?.end ?? row.sent_at ?? row.created_at);
    const marked = new Date(recorded instanceof Date ? recorded.toISOString() : (recorded ?? ''));
    windows.set(rest.slice(0, at), {
      start: Number.isNaN(marked.getTime()) ? keyStart : marked,
      open,
      key: row.key,
    });
  }
  return windows;
}

/**
 * The newest digest row per current sponsor. The range on `idempotency_key` is the message log's
 * (workspace, key) unique index walked backwards, so each sponsor costs one index lookup; the old
 * `DISTINCT ON` built a row for every digest ever sent and sorted them, on every five-minute sweep
 * (#1227, #1272 review).
 */
export function digestWindowsQuery(workspaceId: string) {
  const prefix = `agent-digest:${workspaceId}:`;
  // The upper end is a real window start, never a sentinel character: a locale-aware collation
  // (glibc en_US.utf8, ICU) ignores punctuation and gives U+FFFF no weight, so a
  // `key < prefix || sponsor || U+FFFF` range was empty outside the C collation and the window of a
  // failed digest was never found (#1272 review). Every suffix is an ISO-8601 window start or a UTC
  // day of this century, so it begins with a digit below '9' and `:9999-…` is above all of them.
  // Sponsor ids all have the same width, so no sponsor's range can reach another sponsor's keys.
  const after = ':9999-12-31T23:59:59.999Z';
  return sql`
    SELECT m.idempotency_key AS key, m.status, m.data, m.sent_at, m.created_at
    FROM (SELECT DISTINCT sponsor_user_id AS sponsor FROM agents WHERE workspace_id = ${workspaceId}) s
    CROSS JOIN LATERAL (
      SELECT idempotency_key, status, data, sent_at, created_at
      FROM messages
      WHERE workspace_id = ${workspaceId}
        AND idempotency_key >= ${prefix} || s.sponsor || ':'
        AND idempotency_key < ${prefix} || s.sponsor || ${after}
      ORDER BY idempotency_key DESC
      LIMIT 1
    ) m`;
}

async function notifyDigest(
  deps: AgentNotificationDeps,
  tx: Tx,
  workspaceId: string,
  cursor: typeof schema.agentNotificationCursor.$inferSelect,
  now: Date,
): Promise<{ sent: number; at: Date | null }> {
  // A first digest looks back one day; the cursor is the baseline for a sponsor with no row yet.
  const base = cursor.lastDigestAt ?? new Date(now.getTime() - DIGEST_WINDOW_MS);
  const windows = await digestWindows(tx, workspaceId);
  const windowOf = (sponsor: string): DigestWindow => windows.get(sponsor) ?? { start: base, open: false, key: '' };
  const due = (start: Date) => now.getTime() - start.getTime() >= DIGEST_WINDOW_MS;
  // Nothing is due while every window is closed and younger than a day, and the baseline is too:
  // the sweep does no ledger work on the four out of five minutes that are not a digest minute.
  if (![...windows.values()].some((window) => window.open || due(window.start)) && !due(base)) return { sent: 0, at: null };

  // The window starts where a sponsor's last digest ended, so a retry hours later still covers the
  // same actions and a late pass leaves no gap (#1184). A window kept open by a failure is bounded,
  // so a sponsor who can never be mailed cannot make every sweep re-read the whole ledger (#1227).
  const oldest = Math.min(base.getTime(), ...[...windows.values()].map((window) => window.start.getTime()));
  const since = new Date(Math.max(oldest, now.getTime() - MAX_DIGEST_LOOKBACK_MS));
  const recent = (
    await tx
      .select()
      .from(schema.agentActions)
      .where(
        and(
          eq(schema.agentActions.workspaceId, workspaceId),
          gt(schema.agentActions.at, since),
          // The window ends at this pass's own clock. An action committed while the sweep ran is
          // newer than the recorded cutoff and belongs to the next digest; including it here would
          // report it twice (#1272 review).
          lte(schema.agentActions.at, now),
        ),
      )
      .orderBy(asc(schema.agentActions.id))
  ).filter((a) => a.actionClass !== 'draft');
  if (!recent.length) return { sent: 0, at: null };

  const byAgent = new Map<string, ActionRow[]>();
  for (const action of recent) byAgent.set(action.agentId, [...(byAgent.get(action.agentId) ?? []), action]);
  const agents = await tx
    .select()
    .from(schema.agents)
    .where(inArray(schema.agents.id, [...byAgent.keys()]));
  const bySponsor = new Map<string, AgentDigest[]>();
  for (const agent of agents) {
    // Each sponsor is cut at their own window, so one sponsor being behind the others costs only
    // that sponsor the extra lines (#1227).
    const window = windowOf(agent.sponsorUserId);
    const actions = (byAgent.get(agent.id) ?? []).filter((action) => action.at > window.start);
    if (!actions.length) continue;
    const counts = { allow: 0, hold: 0, ask: 0, deny: 0 };
    for (const a of actions) counts[a.decision]++;
    const holds: AgentDigest['holds'] = [];
    for (const action of actions.filter((a) => a.decision === 'hold'))
      holds.push({ action, approval: await approvalForAction(tx, action) });
    const digest: AgentDigest = {
      agent,
      counts,
      autonomous: actions.filter((a) => a.decision === 'allow' && a.ok),
      holds,
      refusals: actions.filter((a) => a.decision === 'deny'),
    };
    bySponsor.set(agent.sponsorUserId, [...(bySponsor.get(agent.sponsorUserId) ?? []), digest]);
  }

  let sent = 0;
  let attempted = false;
  let durable = true;
  for (const [sponsor, own] of bySponsor) {
    const window = windowOf(sponsor);
    if (!due(window.start)) continue;
    attempted = true;
    // A retry of an open window reuses its exact key, so the sponsor gets one digest per window
    // even when the retry crosses UTC midnight (#1184).
    const key = window.open ? window.key : `agent-digest:${workspaceId}:${sponsor}:${window.start.toISOString()}`;
    const content = digestEmail(deps.publicUrl, own);
    const results = await sendMemberEmails(tx, deps, workspaceId, [
      {
        userId: sponsor,
        idempotencyKey: key,
        ...content,
        data: {
          digest: own.map((d) => ({ agentId: d.agent.id, counts: d.counts })),
          // Where this digest's window began and ended, so the next one starts here even when the
          // pass runs on a clock of its own (a test) or late (#1184, #1227). A retry overwrites
          // the end with its own, so the successful send closes the window where it ended.
          digestWindow: { start: window.start.toISOString(), end: now.toISOString() },
        },
      },
    ]);
    if (results.every((r) => r.status === 'sent')) {
      sent++;
      continue;
    }
    // A failed attempt only leaves a window to retry when it left a row behind (a recipient who is
    // not a member). Without a transactional provider the helper returns before writing one, so the
    // baseline must not move: the activity would otherwise be skipped once a provider appears
    // (#1272 review).
    const [record] = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.workspaceId, workspaceId), eq(schema.messages.idempotencyKey, key)));
    if (!record) durable = false;
  }
  // The baseline moves on even when a sponsor's mail failed: their own row keeps that window open
  // for a retry, and the others must not wait a day for it (#1227). It stays put only when an
  // attempt left no record at all.
  return { sent, at: attempted && durable ? now : null };
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
  const plan = await deps.db.withWorkspace(workspaceId, async (tx) => {
    let [cursor] = await tx
      .select()
      .from(schema.agentNotificationCursor)
      .where(eq(schema.agentNotificationCursor.workspaceId, workspaceId));
    if (!cursor) {
      // The first run starts at the head of the ledger: a workspace upgraded from a version before
      // the feature must not replay its historical holds, refusals and asks (#266).
      const [head] = await tx
        .select({ id: schema.agentActions.id })
        .from(schema.agentActions)
        .where(eq(schema.agentActions.workspaceId, workspaceId))
        .orderBy(desc(schema.agentActions.id))
        .limit(1);
      // The digest waits a day too, so the first sweep after an upgrade does not summarise the
      // historical window it just declined to announce.
      await tx
        .insert(schema.agentNotificationCursor)
        .values({ workspaceId, lastActionId: head?.id ?? 0, lastDigestAt: now })
        .onConflictDoNothing();
      [cursor] = await tx.select().from(schema.agentNotificationCursor).where(eq(schema.agentNotificationCursor.workspaceId, workspaceId));
    }
    if (!cursor) return null;

    // Only the decisions this path announces are read, so a burst of drafts or allows cannot fill
    // the window and hide a hold behind it (#1234). A draft command can be denied too, and drafts
    // are dropped from these e-mails, so they are excluded here before the limit (#1272 review).
    const actions = await tx
      .select()
      .from(schema.agentActions)
      .where(
        and(
          eq(schema.agentActions.workspaceId, workspaceId),
          gt(schema.agentActions.id, cursor.lastActionId),
          inArray(schema.agentActions.decision, ['hold', 'ask', 'deny']),
          ne(schema.agentActions.actionClass, 'draft'),
        ),
      )
      .orderBy(asc(schema.agentActions.id))
      .limit(MAX_ACTIONS_PER_RUN);
    return { cursor, actions };
  });
  if (!plan) return emptySummary();

  // Each send commits before the cursor bookkeeping below, so an error after an e-mail went out
  // cannot roll its message row back: the next sweep finds the row by its idempotency key, sees
  // "sent" and does not send again. A failed send is kept pending by the cursor rule below.
  const events = await deps.db.withWorkspace(workspaceId, (tx) => notifyEvents(deps, tx, workspaceId, plan.actions, now));
  const digest = await deps.db.withWorkspace(workspaceId, (tx) => notifyDigest(deps, tx, workspaceId, plan.cursor, now));
  const expiry = await deps.db.withWorkspace(workspaceId, (tx) => notifyExpiry(deps, tx, workspaceId, plan.cursor, now));

  // Advance only past actions whose notification reached every recipient. The first failure stops
  // the cursor before its action, so the next sweep retries it (with the same idempotency key)
  // instead of silently dropping it.
  const successful = events.firstFailedActionId === null ? plan.actions : plan.actions.filter((a) => a.id < events.firstFailedActionId!);
  const lastActionId = successful.reduce((max, a) => Math.max(max, a.id), plan.cursor.lastActionId);

  await deps.db.withWorkspace(workspaceId, (tx) =>
    tx
      .update(schema.agentNotificationCursor)
      .set({
        lastActionId,
        lastDigestAt: digest.at ?? plan.cursor.lastDigestAt,
        expiryNotified: expiry.notified,
      })
      .where(eq(schema.agentNotificationCursor.workspaceId, workspaceId)),
  );

  return { events: events.sent, digests: digest.sent, expiries: expiry.sent };
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
    await sleep(tickMs, signal);
  }
}
