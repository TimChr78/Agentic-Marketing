import { newId } from '@agentic-marketing/core';
import { type AlertChannel, type AlertKind, type AlertNotification, schema, type Tx } from '@agentic-marketing/db';
import { MESSAGE_ID_HEADER, transportFor } from '@agentic-marketing/email';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray } from 'drizzle-orm';
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

async function notifyWebhook(tx: Tx, input: NotifyInput, channel: Extract<AlertChannel, { type: 'webhook' }>, url: string) {
  const [endpoint] = await tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, channel.webhookId));
  if (!endpoint?.enabled)
    return {
      event: input.event,
      channel: 'webhook' as const,
      target: channel.webhookId,
      at: input.now.toISOString(),
      status: 'failed' as const,
      error: 'the webhook endpoint was deleted or disabled',
    };
  const idempotencyKey = `alert:${input.eventId}:${input.event}:${channel.webhookId}`;
  const values = {
    workspaceId: input.workspace.id,
    id: newId('dlv'),
    kind: 'webhook' as const,
    targetId: channel.webhookId,
    payload: alertPayload(input, url),
    status: 'pending' as const,
    idempotencyKey,
  };
  const [inserted] = await tx.insert(schema.deliveries).values(values).onConflictDoNothing().returning({ id: schema.deliveries.id });
  let deliveryId = inserted?.id;
  if (!deliveryId) {
    const [existing] = await tx
      .select({ id: schema.deliveries.id })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.idempotencyKey, idempotencyKey));
    deliveryId = existing?.id;
  }
  return {
    event: input.event,
    channel: 'webhook' as const,
    target: channel.webhookId,
    at: input.now.toISOString(),
    status: 'sent' as const,
    deliveryId,
  };
}

async function notifyEmails(tx: Tx, deps: NotifyDeps, input: NotifyInput, userIds: string[], url: string): Promise<AlertNotification[]> {
  const people = await deps.directory.users(userIds);
  // A person removed from the workspace after the rule was written must not keep receiving it.
  const stillMembers = new Set(
    (
      await tx
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, input.workspace.id), inArray(schema.workspaceMembers.userId, userIds)))
    ).map((r) => r.userId),
  );
  const providers = await tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.enabled, true));
  const provider = providers.find((p) => p.useFor.includes('transactional'));
  const at = input.now.toISOString();
  if (!provider)
    return userIds.map((target) => ({
      event: input.event,
      channel: 'email',
      target,
      at,
      status: 'failed',
      error: 'no enabled transactional e-mail provider',
    }));

  const content = emailContent(input, url);
  const out: AlertNotification[] = [];
  let transport: Awaited<ReturnType<typeof transportFor>> | undefined;
  try {
    transport = await transportFor(tx, provider, deps.kp, deps.email.adapterDeps);
    for (const userId of userIds) {
      const person = people.get(userId);
      if (!person || !stillMembers.has(userId)) {
        out.push({ event: input.event, channel: 'email', target: userId, at, status: 'failed', error: 'not a workspace member' });
        continue;
      }
      const idempotencyKey = `alert:${input.eventId}:${input.event}:${userId}`;
      const [existing] = await tx
        .select({ id: schema.messages.id, status: schema.messages.status })
        .from(schema.messages)
        .where(and(eq(schema.messages.workspaceId, input.workspace.id), eq(schema.messages.idempotencyKey, idempotencyKey)));
      if (existing?.status === 'sent') {
        out.push({ event: input.event, channel: 'email', target: userId, at, status: 'sent' });
        continue;
      }
      // A failed alert e-mail is retried on the next evaluation; reuse its message row so the
      // log shows one attempt history rather than a new message per retry.
      const messageId = existing?.id ?? newId('msg');
      if (existing)
        await tx
          .update(schema.messages)
          .set({ status: 'sending', reason: null, attempts: 0, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
      else
        await tx.insert(schema.messages).values({
          workspaceId: input.workspace.id,
          id: messageId,
          idempotencyKey,
          purpose: 'onboarding',
          providerId: provider.id,
          status: 'sending',
          data: { alert: { ruleId: input.rule.id, event: input.event } },
        });
      try {
        const { providerMessageId } = await transport.send({
          messageId,
          from: { email: provider.fromEmail, name: provider.fromName || undefined },
          replyTo: provider.replyTo ?? undefined,
          to: person.email,
          subject: content.subject,
          html: content.html,
          text: content.text,
          headers: { [MESSAGE_ID_HEADER]: messageId },
          stream: 'transactional',
        });
        await tx
          .update(schema.messages)
          .set({ status: 'sent', providerMessageId, reason: null, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
        out.push({ event: input.event, channel: 'email', target: userId, at, status: 'sent' });
      } catch (err) {
        const error = (err as Error).message.split('\n')[0];
        logger.warn({ err, rule: input.rule.id, userId }, 'alert e-mail failed');
        await tx
          .update(schema.messages)
          .set({ status: 'failed', reason: `provider_error: ${error}`, updatedAt: new Date() })
          .where(eq(schema.messages.id, messageId));
        out.push({ event: input.event, channel: 'email', target: userId, at, status: 'failed', error });
      }
    }
  } catch (err) {
    const error = (err as Error).message.split('\n')[0];
    logger.warn({ err, rule: input.rule.id }, 'alert e-mail transport could not be created');
    for (const userId of userIds)
      if (!out.some((n) => n.target === userId))
        out.push({ event: input.event, channel: 'email', target: userId, at, status: 'failed', error });
  } finally {
    await transport?.close?.();
  }
  return out;
}

/** Sends one event to the selected channels. The caller stores the returned `notified` entries. */
export async function notifyChannels(tx: Tx, deps: NotifyDeps, input: NotifyInput, channels: AlertChannel[]): Promise<AlertNotification[]> {
  const url = alertUrl(deps, input.rule.id);
  const out: AlertNotification[] = [];
  const emailIds: string[] = [];
  for (const channel of channels) {
    if (channel.type === 'webhook') out.push(await notifyWebhook(tx, input, channel, url));
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
