import { newId, redactCredentials } from '@agentic-marketing/core';
import { type AlertChannel, type AlertKind, type AlertNotification, type DeliveryStatus, schema, type Tx } from '@agentic-marketing/db';
import { MESSAGE_ID_HEADER, sendRequestHash, transportFor } from '@agentic-marketing/email';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { NotifyDeps } from './deps';
import { type AlertConfig, isRatioMetric, metricId, metricLabel, windowLabel } from './rules';

// Notification is deliberately two narrow paths: the existing signed webhook outbox (so retries,
// backoff and the egress guard are not reimplemented) and a short transactional e-mail recorded
// in the message log. Payloads and messages carry aggregates only, never a person.

export interface NotifyInput {
  workspace: { id: string; name: string };
  rule: { id: string; name: string; kind: AlertKind; config: AlertConfig };
  eventId: string;
  event: 'firing' | 'resolved' | 'test';
  value: number;
  threshold: number;
  window: string;
  previous?: number;
  now: Date;
}

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function formatValue(kind: AlertKind, value: number): string {
  if (isRatioMetric(kind)) return `${(value * 100).toFixed(2)}%`;
  return value.toLocaleString('en-US');
}

function alertUrl(deps: NotifyDeps, ruleId: string): string {
  return `${deps.publicUrl.replace(/\/$/, '')}/insights/alerts?rule=${encodeURIComponent(ruleId)}`;
}

/** The signed webhook payload, shared by real alerts and tests. */
export function alertPayload(input: NotifyInput, url: string) {
  return {
    type: `alert.${input.event}`,
    rule: { id: input.rule.id, name: input.rule.name, kind: input.rule.kind, config: input.rule.config },
    metric: metricLabel(input.rule.kind, input.rule.config),
    measure: metricId(input.rule.kind, input.rule.config),
    value: input.value,
    threshold: input.threshold,
    window: input.window,
    workspace: { id: input.workspace.id, name: input.workspace.name },
    url,
    occurredAt: input.now.toISOString(),
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  };
}

function emailContent(input: NotifyInput, url: string) {
  const label = metricLabel(input.rule.kind, input.rule.config);
  const value = formatValue(input.rule.kind, input.value);
  const threshold = formatValue(input.rule.kind, input.threshold);
  const window = windowLabel(input.window);
  const state = input.event === 'resolved' ? 'recovered' : input.event === 'test' ? 'test' : 'firing';
  const subject =
    input.event === 'test'
      ? `Alert test: ${input.rule.name}`
      : input.event === 'resolved'
        ? `Alert resolved: ${input.rule.name}`
        : `Alert firing: ${input.rule.name}`;
  const previous = input.previous === undefined ? '' : `\nPrevious window: ${formatValue(input.rule.kind, input.previous)} signups.`;
  const text = [
    `${input.rule.name} is ${state}.`,
    '',
    `Metric: ${label}`,
    `Value: ${value}`,
    `Threshold: ${threshold}`,
    `Window: ${window}${previous}`,
    '',
    `Open the alert: ${url}`,
    '',
    `This is an aggregate alert for ${input.workspace.name}. It contains no personal data.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p><strong>${escapeHtml(input.rule.name)}</strong> is ${escapeHtml(state)}.</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr><td style="padding:2px 12px 2px 0;color:#555">Metric</td><td>${escapeHtml(label)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#555">Value</td><td>${escapeHtml(value)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#555">Threshold</td><td>${escapeHtml(threshold)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#555">Window</td><td>${escapeHtml(window)}</td></tr>
${input.previous === undefined ? '' : `<tr><td style="padding:2px 12px 2px 0;color:#555">Previous window</td><td>${escapeHtml(formatValue(input.rule.kind, input.previous))} signups</td></tr>`}
</table>
<p><a href="${escapeHtml(url)}">Open the alert</a></p>
<p style="color:#777;font-size:12px">This is an aggregate alert for ${escapeHtml(input.workspace.name)}. It contains no personal data.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * How many outbox cycles one alert webhook may use. A cycle is the delivery worker's own backoff
 * schedule (seven attempts over ~17 hours); after the first exhausts, the evaluator re-opens the
 * same row for one more cycle, then records a permanent failure. Bounded so a dead endpoint cannot
 * keep a firing rule retrying forever, and the same row is reused so no duplicate is queued.
 */
export const MAX_ALERT_DELIVERY_CYCLES = 2;

/** The notification state that matches a delivery row: only `done` counts as delivered. */
export function deliveryNotificationStatus(status: DeliveryStatus): AlertNotification['status'] {
  if (status === 'done') return 'sent';
  if (status === 'dead' || status === 'failed') return 'failed';
  return 'queued';
}

type DeliveryState = { id: string; status: DeliveryStatus; attempts: number; error: string | null; retryCycles?: number };

/** The ledger entry for one webhook delivery row, without inventing a second queued row. */
function notificationOf(
  input: NotifyInput,
  target: string,
  delivery: Pick<DeliveryState, 'id' | 'status' | 'attempts' | 'retryCycles'>,
  _previous: AlertNotification | undefined,
  error?: string | null,
): AlertNotification {
  const status = deliveryNotificationStatus(delivery.status);
  return {
    event: input.event,
    channel: 'webhook',
    target,
    at: input.now.toISOString(),
    status,
    deliveryId: delivery.id,
    attempts: delivery.attempts,
    cycles: (delivery.retryCycles ?? 0) + 1,
    ...(status === 'failed'
      ? { error: error ?? 'the delivery ended without a response', retryable: (delivery.retryCycles ?? 0) + 1 < MAX_ALERT_DELIVERY_CYCLES }
      : error
        ? { error }
        : {}),
  };
}

async function reopenAlertDelivery(tx: Tx, id: string): Promise<(DeliveryState & { retryCycles: number }) | undefined> {
  const [row] = await tx
    .update(schema.deliveries)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseUntil: null,
      statusCode: null,
      response: null,
      error: null,
      durationMs: null,
      finishedAt: null,
      alertRetryCycles: sql`${schema.deliveries.alertRetryCycles} + 1`,
    })
    .where(
      and(
        eq(schema.deliveries.id, id),
        inArray(schema.deliveries.status, ['dead', 'failed']),
        lt(schema.deliveries.alertRetryCycles, MAX_ALERT_DELIVERY_CYCLES - 1),
      ),
    )
    .returning({
      id: schema.deliveries.id,
      status: schema.deliveries.status,
      attempts: schema.deliveries.attempts,
      error: schema.deliveries.error,
      retryCycles: schema.deliveries.alertRetryCycles,
    });
  return row;
}

async function notifyWebhook(
  tx: Tx,
  input: NotifyInput,
  channel: Extract<AlertChannel, { type: 'webhook' }>,
  url: string,
  existing: AlertNotification | undefined,
) {
  const [endpoint] = await tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, channel.webhookId));
  if (!endpoint?.enabled)
    return {
      event: input.event,
      channel: 'webhook' as const,
      target: channel.webhookId,
      at: input.now.toISOString(),
      status: 'failed' as const,
      error: 'the webhook endpoint was deleted or disabled',
      retryable: false,
    };
  const idempotencyKey = `alert:${input.eventId}:${input.event}:${channel.webhookId}`;
  const [inserted] = await tx
    .insert(schema.deliveries)
    .values({
      workspaceId: input.workspace.id,
      id: newId('dlv'),
      kind: 'webhook' as const,
      targetId: channel.webhookId,
      payload: alertPayload(input, url),
      status: 'pending' as const,
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveries.id });
  if (inserted) return notificationOf(input, channel.webhookId, { id: inserted.id, status: 'pending', attempts: 0 }, existing);

  const [current] = await tx
    .select({
      id: schema.deliveries.id,
      status: schema.deliveries.status,
      attempts: schema.deliveries.attempts,
      error: schema.deliveries.error,
      retryCycles: schema.deliveries.alertRetryCycles,
    })
    .from(schema.deliveries)
    .where(eq(schema.deliveries.idempotencyKey, idempotencyKey));
  if (!current)
    return {
      event: input.event,
      channel: 'webhook' as const,
      target: channel.webhookId,
      at: input.now.toISOString(),
      status: 'failed' as const,
      error: 'the queued delivery disappeared; it will be queued again',
      retryable: true,
    };

  // A terminal delivery is retried in a new cycle, but only while the bounded budget lasts and
  // only when the caller selected this channel (i.e. the ledger no longer says sent). Reuse the
  // row: the unique idempotency key keeps one delivery per event/channel, and an in-flight
  // (pending/running) row is never reset.
  if (current.status === 'dead' || current.status === 'failed') {
    const reopened = await reopenAlertDelivery(tx, current.id);
    if (reopened) return notificationOf(input, channel.webhookId, reopened, existing);
    // A competing scheduler/worker may have advanced it while the UPDATE waited. Re-read.
    const [latest] = await tx
      .select({
        id: schema.deliveries.id,
        status: schema.deliveries.status,
        attempts: schema.deliveries.attempts,
        error: schema.deliveries.error,
        retryCycles: schema.deliveries.alertRetryCycles,
      })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, current.id));
    return notificationOf(input, channel.webhookId, latest ?? current, existing, latest ? latest.error : current.error);
  }

  return notificationOf(input, channel.webhookId, current, existing, current.error);
}

/**
 * Re-reads the outbox rows behind a ledger and makes the ledger truthful (#368): pending/running
 * stays `queued`, done becomes `sent`, dead/failed becomes `failed` with the bounded retry flag.
 * With retry enabled, atomically re-opens terminal rows within their durable budget; payloads stay unchanged.
 */
export async function reconcileAlertNotifications(
  tx: Tx,
  notified: AlertNotification[],
  opts: { retry?: boolean } = {},
): Promise<AlertNotification[]> {
  const ids = [...new Set(notified.flatMap((n) => (n.deliveryId ? [n.deliveryId] : [])))];
  if (!ids.length) return notified;
  const rows = await tx
    .select({
      id: schema.deliveries.id,
      status: schema.deliveries.status,
      attempts: schema.deliveries.attempts,
      error: schema.deliveries.error,
      retryCycles: schema.deliveries.alertRetryCycles,
    })
    .from(schema.deliveries)
    .where(inArray(schema.deliveries.id, ids));
  if (opts.retry) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.status === 'dead' || row.status === 'failed') rows[i] = (await reopenAlertDelivery(tx, row.id)) ?? row;
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  let changed = false;
  const out = notified.map((n) => {
    if (!n.deliveryId) return n;
    const delivery = byId.get(n.deliveryId);
    if (!delivery) {
      // The row and its payload are gone; this notification cannot retry automatically.
      const missing = {
        ...n,
        status: 'failed' as const,
        error: 'the queued delivery row no longer exists',
        retryable: false,
      };
      changed = true;
      return missing;
    }
    const status = deliveryNotificationStatus(delivery.status);
    const retryable = status === 'failed' ? delivery.retryCycles + 1 < MAX_ALERT_DELIVERY_CYCLES : undefined;
    const error =
      status === 'failed' ? (delivery.error ?? n.error ?? 'the delivery ended without a response') : (delivery.error ?? undefined);
    if (
      n.status === status &&
      n.attempts === delivery.attempts &&
      n.error === error &&
      n.retryable === retryable &&
      n.cycles === delivery.retryCycles + 1
    )
      return n;
    changed = true;
    return {
      ...n,
      status,
      attempts: delivery.attempts,
      cycles: delivery.retryCycles + 1,
      ...(error === undefined ? { error: undefined } : { error }),
      ...(retryable === undefined ? { retryable: undefined } : { retryable }),
    };
  });
  return changed ? out : notified;
}

export interface MemberEmail {
  userId: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  html: string;
  /** The transactional purpose recorded in the message log (default onboarding). */
  purpose?: string;
  data?: Record<string, unknown>;
}

export interface MemberEmailResult {
  userId: string;
  status: 'sent' | 'failed';
  error?: string;
}

/**
 * Sends transactional e-mails to workspace members through the enabled transactional provider,
 * deduplicating by idempotency key. Shared by alerts and agent notifications, which both write a
 * short message to the log rather than reimplementing provider selection and retries.
 */
export async function sendMemberEmails(tx: Tx, deps: NotifyDeps, workspaceId: string, emails: MemberEmail[]): Promise<MemberEmailResult[]> {
  const userIds = [...new Set(emails.map((e) => e.userId))];
  const people = await deps.directory.users(userIds);
  // A person removed from the workspace must not keep receiving workspace mail.
  const stillMembers = new Set(
    (
      await tx
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(schema.workspaceMembers.userId, userIds)))
    ).map((r) => r.userId),
  );
  const providers = await tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.enabled, true));
  const provider = providers.find((p) => p.useFor.includes('transactional'));
  if (!provider)
    return emails.map((email) => ({
      userId: email.userId,
      status: 'failed',
      error: 'no enabled transactional e-mail provider',
    }));

  const out: MemberEmailResult[] = [];
  let transport: Awaited<ReturnType<typeof transportFor>> | undefined;
  try {
    transport = await transportFor(tx, provider, deps.kp, deps.email.adapterDeps);
    for (const email of emails) {
      const person = people.get(email.userId);
      if (!person || !stillMembers.has(email.userId)) {
        out.push({ userId: email.userId, status: 'failed', error: 'not a workspace member' });
        continue;
      }
      const [existing] = await tx
        .select({ id: schema.messages.id, status: schema.messages.status })
        .from(schema.messages)
        .where(and(eq(schema.messages.workspaceId, workspaceId), eq(schema.messages.idempotencyKey, email.idempotencyKey)));
      // Any row the provider may already have accepted counts as done. Marking `delivered`,
      // `bounced` or `complained` is a delivery webhook after the send, not a failure: `sent` alone
      // would resend a mail that was delivered. Only a failed or suppressed row is retried.
      if (existing && existing.status !== 'failed' && existing.status !== 'suppressed') {
        out.push({ userId: email.userId, status: 'sent' });
        continue;
      }
      // A failed e-mail is retried on the next run; reuse its message row so the log shows one
      // attempt history rather than a new message per retry.
      const messageId = existing?.id ?? newId('msg');
      if (existing)
        await tx
          .update(schema.messages)
          .set({ status: 'sending', reason: null, attempts: 0, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
      else
        await tx.insert(schema.messages).values({
          workspaceId,
          id: messageId,
          idempotencyKey: email.idempotencyKey,
          purpose: email.purpose ?? 'onboarding',
          providerId: provider.id,
          status: 'sending',
          data: email.data ?? {},
          requestHash: sendRequestHash('email', { caller: 'system:alert', recipient: email.userId, key: email.idempotencyKey }),
        });
      try {
        const { providerMessageId } = await transport.send({
          messageId,
          from: { email: provider.fromEmail, name: provider.fromName || undefined },
          replyTo: provider.replyTo ?? undefined,
          to: person.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
          headers: { [MESSAGE_ID_HEADER]: messageId },
          stream: 'transactional',
        });
        await tx
          .update(schema.messages)
          .set({ status: 'sent', providerMessageId, reason: null, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
        out.push({ userId: email.userId, status: 'sent' });
      } catch (err) {
        const error = redactCredentials((err as Error).message).split('\n')[0]!; // redact whole, then cut (#885)
        logger.warn({ err, idempotencyKey: email.idempotencyKey, userId: email.userId }, 'member e-mail failed');
        await tx
          .update(schema.messages)
          .set({ status: 'failed', reason: `provider_error: ${error}`, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
        out.push({ userId: email.userId, status: 'failed', error });
      }
    }
  } catch (err) {
    const error = redactCredentials((err as Error).message).split('\n')[0]!; // redact whole, then cut (#885)
    logger.warn({ err }, 'member e-mail transport could not be created');
    for (const email of emails)
      if (!out.some((n) => n.userId === email.userId && n.status === 'failed')) out.push({ userId: email.userId, status: 'failed', error });
  } finally {
    await transport?.close?.();
  }
  return out;
}

async function notifyEmails(tx: Tx, deps: NotifyDeps, input: NotifyInput, userIds: string[], url: string): Promise<AlertNotification[]> {
  const content = emailContent(input, url);
  const at = input.now.toISOString();
  const results = await sendMemberEmails(
    tx,
    deps,
    input.workspace.id,
    userIds.map((userId) => ({
      userId,
      idempotencyKey: `alert:${input.eventId}:${input.event}:${userId}`,
      ...content,
      data: { alert: { ruleId: input.rule.id, event: input.event } },
    })),
  );
  return results.map((r) => ({
    event: input.event,
    channel: 'email' as const,
    target: r.userId,
    at,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
  }));
}

/**
 * Sends one event to the selected channels. The caller stores the returned `notified` entries.
 * `existing` is the reconciled ledger; it only supplies the bounded retry cycle of a dead webhook.
 */
export async function notifyChannels(
  tx: Tx,
  deps: NotifyDeps,
  input: NotifyInput,
  channels: AlertChannel[],
  existing: AlertNotification[] = [],
): Promise<AlertNotification[]> {
  const url = alertUrl(deps, input.rule.id);
  const out: AlertNotification[] = [];
  const emailIds: string[] = [];
  for (const channel of channels) {
    if (channel.type === 'webhook')
      out.push(
        await notifyWebhook(
          tx,
          input,
          channel,
          url,
          existing.find((n) => n.event === input.event && n.channel === 'webhook' && n.target === channel.webhookId),
        ),
      );
    else emailIds.push(...channel.userIds);
  }
  if (emailIds.length) out.push(...(await notifyEmails(tx, deps, input, [...new Set(emailIds)], url)));
  return out;
}

/** Keeps earlier notifications and replaces the entry for the same event/channel/target. */
export function mergeNotifications(existing: AlertNotification[], fresh: AlertNotification[]): AlertNotification[] {
  const out = [...existing];
  for (const notification of fresh) {
    const index = out.findIndex(
      (n) => n.event === notification.event && n.channel === notification.channel && n.target === notification.target,
    );
    if (index >= 0) out[index] = notification;
    else out.push(notification);
  }
  return out;
}
