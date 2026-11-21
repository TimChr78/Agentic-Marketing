import { DEFAULT_PURPOSES, publishedSingleton, type SmsTemplate } from '@agentic-marketing/artifacts';
import { newId, newUuid } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { consentStateOf, currentConsent, profileForMessage, purposeAllowed } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DeliveryAttempt } from '../attempt';
import type { Decision, EmailServices } from '../gateway';
import { idempotencyKeyReused, legacySameSend, lockSendKey, topicSuppression } from '../gateway';
import { decisionEvent, defer, enqueueMessageEvents, MAX_ATTEMPTS, retryDelaySeconds } from '../outbox';
import { checkPolicy, isMarketing } from '../policy';
import { failureText } from '../render';
import { billingOf, smsTransportFor, smsWebhookPath } from './providers';
import { renderSms } from './render';

// The SMS side of the send gateway: the same outbox, consent, suppression and delivery policy as
// e-mail, with the phone number as the address and a monthly budget per provider.

export interface SmsRequest {
  profileId: string;
  templateId: string;
  idempotencyKey?: string;
  journeyId?: string;
  /** Overrides the template's topic, e.g. a broadcast's choice. */
  topic?: string;
  data?: Record<string, unknown>;
  /** Hold the message until then (a recipient-local send window). */
  notBefore?: Date;
  /** The agent behind this message (#426): a direct send, or the owner of the journey. */
  agentId?: string | null;
  /** The immutable request fingerprint (#926); see `sendRequestHash` in the e-mail gateway. */
  requestHash: string;
}

type Verdict =
  | { ok: true; phone: string; phoneHash: string; vars: Record<string, unknown>; basis: string; profileId: string }
  | { ok: false; reason: string };

const purposesOf = async (tx: Tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;

/** Lawful basis, number and suppression for one person and purpose. */
export async function checkSmsRecipient(
  tx: Tx,
  workspaceId: string,
  kp: KeyProvider,
  profileId: string,
  purpose: string,
  topic?: string | null,
): Promise<Verdict> {
  const person = await profileForMessage(tx, workspaceId, profileId, kp);
  if (!person) return { ok: false, reason: 'no_profile: the person does not exist (or was erased)' };
  if (!person.phone || !person.phoneHash) return { ok: false, reason: 'no_address: no phone number is known for this person' };
  const p = (await purposesOf(tx)).find((x) => x.key === purpose);
  if (!p) return { ok: false, reason: `unknown_purpose: "${purpose}" is not a configured purpose` };
  const state = currentConsent(await consentStateOf(tx, workspaceId, person.id), purpose, 'sms');
  if (!purposeAllowed(p.basis, state?.status))
    return {
      ok: false,
      reason: `no_lawful_basis: purpose "${purpose}" is based on ${p.basis.replace('_', ' ')} and the person's status is ${state?.status ?? 'unknown (no record)'}`,
    };
  const blocked = await topicSuppression(tx, workspaceId, person.id, p, topic);
  if (blocked) return { ok: false, reason: blocked };
  const [sup] = await tx
    .select()
    .from(schema.suppressions)
    .where(and(eq(schema.suppressions.channel, 'sms'), eq(schema.suppressions.valueHash, person.phoneHash)));
  if (sup) return { ok: false, reason: `suppressed: the number is on the suppression list (${sup.reason})` };
  return { ok: true, phone: person.phone, phoneHash: person.phoneHash, vars: person.vars, basis: p.basis, profileId: person.id };
}

async function publishedSmsTemplate(tx: Tx, templateId: string, version?: number | null) {
  const [row] = await tx
    .select({
      type: schema.artifacts.type,
      published: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
      number: schema.artifactVersions.number,
    })
    .from(schema.artifacts)
    .leftJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        version ? eq(schema.artifactVersions.number, version) : eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  if (row?.type !== 'sms_template') return null;
  return row.content && row.number ? { version: row.number, template: row.content as SmsTemplate } : { version: null, template: null };
}

/** Records an SMS request and decides it, like requestEmail. */
export async function requestSms(tx: Tx, workspaceId: string, kp: KeyProvider, req: SmsRequest): Promise<Decision> {
  const key = req.idempotencyKey ?? newUuid();
  if (req.idempotencyKey) await lockSendKey(tx, workspaceId, key);
  const [existing] = await tx.select().from(schema.messages).where(eq(schema.messages.idempotencyKey, key));
  if (existing) {
    const same = existing.requestHash === null ? legacySameSend(existing, req) : existing.requestHash === req.requestHash;
    if (!same) throw idempotencyKeyReused('send');
    return { messageId: existing.id, status: existing.status, reason: existing.reason, duplicate: true };
  }

  const tpl = await publishedSmsTemplate(tx, req.templateId);
  const purpose = tpl?.template?.purpose ?? 'unknown';
  const topic = req.topic ?? tpl?.template?.topic ?? null;
  let status: Decision['status'] = 'queued';
  let reason: string | null = null;
  let profileId = req.profileId;
  let recipientHash: string | null = null;
  if (!tpl) [status, reason] = ['failed', `no_template: ${req.templateId} is not an SMS template in this workspace`];
  else if (!tpl.template) [status, reason] = ['failed', `not_published: template ${req.templateId} has no published version`];
  else {
    const v = await checkSmsRecipient(tx, workspaceId, kp, req.profileId, purpose, topic);
    if (!v.ok) [status, reason] = ['suppressed', v.reason];
    else [profileId, recipientHash] = [v.profileId, v.phoneHash];
  }
  const [m] = await tx
    .insert(schema.messages)
    .values({
      workspaceId,
      id: newId('msg'),
      idempotencyKey: key,
      channel: 'sms',
      profileId,
      purpose,
      topic,
      templateId: req.templateId,
      templateVersion: tpl?.version ?? null,
      journeyId: req.journeyId ?? null,
      status,
      reason,
      recipientHash,
      notBefore: req.notBefore ?? null,
      agentId: req.agentId ?? null,
      requestHash: req.requestHash,
      data: req.data ?? {},
    })
    .returning();
  await enqueueMessageEvents(tx, workspaceId, [decisionEvent(m, status, reason ?? '')]);
  return { messageId: m.id, status, reason, duplicate: false };
}

/** Segments a provider has used this calendar month (UTC). */
async function segmentsThisMonth(tx: Tx, providerId: string) {
  const now = new Date();
  const [{ n }] = await tx
    .select({ n: sql<number>`coalesce(sum(${schema.messages.segments}), 0)::int` })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channel, 'sms'),
        eq(schema.messages.test, false),
        eq(schema.messages.providerId, providerId),
        inArray(schema.messages.status, ['sent', 'delivered', 'bounced']),
        gte(schema.messages.createdAt, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      ),
    );
  return n;
}

export async function deliverSms(
  db: Db,
  ws: string,
  id: string,
  deps: { kp: KeyProvider; events: EventStore; email: EmailServices },
  attempt: DeliveryAttempt = { providerCalled: false },
) {
  const prepared = await db.withWorkspace(ws, async (tx) => {
    // Lock and require `sending`: the stale sweep may have settled this row while the worker was in
    // an earlier message, and a swept or deleted message is never sent or reverted (#1148).
    const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, id)).for('update');
    if (!m || m.status !== 'sending') return { kind: 'done' as const };
    await tx.update(schema.messages).set({ updatedAt: new Date() }).where(eq(schema.messages.id, id));
    const finish = async (status: 'suppressed' | 'failed', reason: string) => {
      const settled = await tx
        .update(schema.messages)
        .set({ status, reason, updatedAt: new Date() })
        .where(and(eq(schema.messages.id, id), eq(schema.messages.status, 'sending')))
        .returning({ id: schema.messages.id });
      // The status and its event commit together (#1008): a decision sees the event either
      // published or queued, never missing. A row the sweep settled keeps its outcome (#1148).
      if (settled.length) await enqueueMessageEvents(tx, ws, [decisionEvent(m, status, reason)]);
      return { kind: 'done' as const };
    };
    const tpl = m.templateId ? await publishedSmsTemplate(tx, m.templateId, m.templateVersion) : null;
    if (!tpl?.template) return finish('failed', 'no_template: the template version is gone');
    const v = await checkSmsRecipient(tx, ws, deps.kp, m.profileId ?? '', m.purpose, m.topic ?? tpl.template.topic);
    if (!v.ok) return finish('suppressed', v.reason);
    const purposes = await purposesOf(tx);
    const hold = await checkPolicy(
      tx,
      ws,
      { ...m, profileId: v.profileId, channel: 'sms', basis: v.basis, timezone: v.vars.timezone },
      purposes,
    );
    if (hold.ok === false) return finish('suppressed', hold.reason);
    if (hold.ok === 'later') {
      const held = await defer(tx, m, hold.until, hold.reason);
      if (held.event) await enqueueMessageEvents(tx, ws, [held.event]);
      return { kind: 'done' as const };
    }
    const marketing = isMarketing(v.basis);
    const stream: 'marketing' | 'transactional' = marketing ? 'marketing' : 'transactional';
    const provider = (await tx.select().from(schema.smsProviders).where(eq(schema.smsProviders.enabled, true))).find((p) =>
      p.useFor.includes(stream),
    );
    if (!provider) return finish('failed', `no_provider: no enabled SMS provider is set up for ${stream} messages`);
    let text: Awaited<ReturnType<typeof renderSms>>;
    try {
      text = await renderSms(tpl.template, { ...m.data, profile: v.vars }, marketing);
    } catch (e) {
      return finish('failed', `render_error: ${failureText((e as Error).message)}`);
    }
    const billing = billingOf(provider);
    if (billing.monthlyBudget !== undefined) {
      const spent = (await segmentsThisMonth(tx, provider.id)) * billing.pricePerSegment;
      if (spent + text.segments * billing.pricePerSegment > billing.monthlyBudget)
        return finish('suppressed', `budget: this month's SMS budget (${billing.monthlyBudget} ${billing.currency}) is used up`);
    }
    return {
      kind: 'send' as const,
      m,
      provider,
      stream,
      segments: text.segments,
      transport: await smsTransportFor(tx, provider, deps.kp, deps.email.adapterDeps),
      out: {
        messageId: m.id,
        to: v.phone,
        from: provider.sender,
        body: text.body,
        statusUrl: `${(await deps.email.publicUrlFor?.(ws)) ?? deps.email.publicUrl}${smsWebhookPath(deps.email.links, ws, provider.id)}/status`,
      },
    };
  });

  if (prepared.kind === 'done') return;
  const { m, provider, transport, out, stream } = prepared;
  attempt.providerCalled = true;
  // Only the provider call's own failure may retry; a failure while recording an accepted send
  // propagates to the round's recovery (`unknown_outcome`), never back to `queued` (#1094 review).
  let sent: Awaited<ReturnType<typeof transport.send>>;
  try {
    sent = await transport.send(out);
  } catch (e) {
    const reason = `provider_error: ${failureText((e as Error).message)}`;
    const retry = m.attempts < MAX_ATTEMPTS;
    const nextAttemptAt = retry ? new Date(Date.now() + retryDelaySeconds(stream, m.attempts) * 1000) : null;
    logger.warn({ messageId: id, provider: provider.adapter, retry, err: (e as Error).message }, 'SMS send failed');
    await db.withWorkspace(ws, async (tx) => {
      const settled = await tx
        .update(schema.messages)
        .set({ status: retry ? 'queued' : 'failed', reason, providerId: provider.id, nextAttemptAt, updatedAt: new Date() })
        .where(and(eq(schema.messages.id, id), eq(schema.messages.status, 'sending')))
        .returning({ id: schema.messages.id });
      if (!settled.length) {
        // The stale sweep settled this attempt as unknown_outcome while the provider was slow. A
        // retry could duplicate a send that may have happened, so the sweep's row stands.
        logger.warn({ messageId: id, provider: provider.adapter }, 'SMS failure arrived after the stale sweep settled the row');
        return;
      }
      await enqueueMessageEvents(tx, ws, [decisionEvent(m, retry ? 'queued' : 'failed', reason, provider.adapter)]);
    });
    return;
  }
  // The outcome and its event commit in one transaction (#1008).
  await db.withWorkspace(ws, async (tx) => {
    const settled = await tx
      .update(schema.messages)
      .set({
        status: 'sent',
        reason: null,
        providerId: provider.id,
        providerMessageId: sent.providerMessageId,
        segments: sent.segments ?? prepared.segments,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.messages.id, id), eq(schema.messages.status, 'sending')))
      .returning({ id: schema.messages.id });
    if (!settled.length) {
      // The provider accepted the message after the sweep recorded unknown_outcome; keep that for
      // a person to check instead of showing a phantom `sent` beside it (#1098 review).
      logger.warn(
        { messageId: id, provider: provider.adapter, providerMessageId: sent.providerMessageId },
        'SMS send finished after the stale sweep settled the row; the sweep outcome stays',
      );
      return;
    }
    await enqueueMessageEvents(tx, ws, [decisionEvent(m, 'sent', '', provider.adapter)]);
  });
}
