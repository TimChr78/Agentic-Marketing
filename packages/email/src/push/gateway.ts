import { DEFAULT_PURPOSES, type PushTemplate, publishedSingleton } from '@agentic-marketing/artifacts';
import { newId, newUuid } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore, MessageEvent } from '@agentic-marketing/events';
import { consentStateOf, currentConsent, profileForMessage, purposeAllowed } from '@agentic-marketing/profiles';
import { type KeyProvider, openJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Decision, EmailServices } from '../gateway';
import type { ClickLink } from '../links';
import { decisionEvent, defer, MAX_ATTEMPTS, retryDelaySeconds } from '../outbox';
import { checkPolicy, isMarketing } from '../policy';
import { type PushKind, type PushRegistration, type PushTransport, pushAdapters } from './adapters';
import { pushTransportFor } from './providers';
import { renderPush } from './render';

// The push side of the send gateway: the same outbox, consent and delivery policy as e-mail and
// SMS. A person's devices are the registrations made with any of their anonymous or user ids; one
// message goes to all of them, and registrations the push service reports gone are deleted.

export interface PushRequest {
  profileId: string;
  templateId: string;
  idempotencyKey?: string;
  journeyId?: string;
  data?: Record<string, unknown>;
  /** Hold the message until then (a recipient-local send window). */
  notBefore?: Date;
}

type Verdict =
  | { ok: true; vars: Record<string, unknown>; basis: string; profileId: string; devices: number }
  | { ok: false; reason: string };

const purposesOf = async (tx: Tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;

/** The registrations of one (canonical) person. */
export async function devicesOf(tx: Tx, workspaceId: string, profileId: string) {
  const ids = await tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value })
    .from(schema.identifiers)
    .where(
      and(
        eq(schema.identifiers.workspaceId, workspaceId),
        eq(schema.identifiers.profileId, profileId),
        inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
      ),
    );
  const anon = ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value);
  const users = ids.filter((i) => i.type === 'user_id').map((i) => i.value);
  if (!anon.length && !users.length) return [];
  const s = schema.pushSubscriptions;
  return tx
    .select()
    .from(s)
    .where(or(anon.length ? inArray(s.anonymousId, anon) : undefined, users.length ? inArray(s.userId, users) : undefined));
}

/** Lawful basis and devices for one person and purpose. */
export async function checkPushRecipient(
  tx: Tx,
  workspaceId: string,
  kp: KeyProvider,
  profileId: string,
  purpose: string,
): Promise<Verdict> {
  const person = await profileForMessage(tx, workspaceId, profileId, kp);
  if (!person) return { ok: false, reason: 'no_profile: the person does not exist (or was erased)' };
  const devices = (await devicesOf(tx, workspaceId, person.id)).length;
  if (!devices) return { ok: false, reason: 'no_address: the person has no device registered for notifications' };
  const p = (await purposesOf(tx)).find((x) => x.key === purpose);
  if (!p) return { ok: false, reason: `unknown_purpose: "${purpose}" is not a configured purpose` };
  const state = currentConsent(await consentStateOf(tx, workspaceId, person.id), purpose, 'push');
  if (!purposeAllowed(p.basis, state?.status))
    return {
      ok: false,
      reason: `no_lawful_basis: purpose "${purpose}" is based on ${p.basis.replace('_', ' ')} and the person's status is ${state?.status ?? 'unknown (no record)'}`,
    };
  return { ok: true, vars: person.vars, basis: p.basis, profileId: person.id, devices };
}

async function publishedPushTemplate(tx: Tx, templateId: string, version?: number | null) {
  const [row] = await tx
    .select({ type: schema.artifacts.type, content: schema.artifactVersions.content, number: schema.artifactVersions.number })
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
  if (row?.type !== 'push_template') return null;
  return row.content && row.number ? { version: row.number, template: row.content as PushTemplate } : { version: null, template: null };
}

/** Records a push request and decides it, like requestEmail. */
export async function requestPush(tx: Tx, workspaceId: string, kp: KeyProvider, events: EventStore, req: PushRequest): Promise<Decision> {
  const key = req.idempotencyKey ?? newUuid();
  const [existing] = await tx.select().from(schema.messages).where(eq(schema.messages.idempotencyKey, key));
  if (existing) return { messageId: existing.id, status: existing.status, reason: existing.reason, duplicate: true };

  const tpl = await publishedPushTemplate(tx, req.templateId);
  const purpose = tpl?.template?.purpose ?? 'unknown';
  let status: Decision['status'] = 'queued';
  let reason: string | null = null;
  let profileId = req.profileId;
  if (!tpl) [status, reason] = ['failed', `no_template: ${req.templateId} is not a push template in this workspace`];
  else if (!tpl.template) [status, reason] = ['failed', `not_published: template ${req.templateId} has no published version`];
  else {
    const v = await checkPushRecipient(tx, workspaceId, kp, req.profileId, purpose);
    if (!v.ok) [status, reason] = ['suppressed', v.reason];
    else profileId = v.profileId;
  }
  const [m] = await tx
    .insert(schema.messages)
    .values({
      workspaceId,
      id: newId('msg'),
      idempotencyKey: key,
      channel: 'push',
      profileId,
      purpose,
      templateId: req.templateId,
      templateVersion: tpl?.version ?? null,
      journeyId: req.journeyId ?? null,
      status,
      reason,
      data: req.data ?? {},
      notBefore: req.notBefore ?? null,
    })
    .returning();
  await events.insertMessageEvents([decisionEvent(m, status, reason ?? '')]);
  return { messageId: m.id, status, reason, duplicate: false };
}

export async function deliverPush(db: Db, ws: string, id: string, deps: { kp: KeyProvider; events: EventStore; email: EmailServices }) {
  const prepared = await db.withWorkspace(ws, async (tx) => {
    const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, id));
    const finish = async (status: 'suppressed' | 'failed', reason: string) => {
      await tx.update(schema.messages).set({ status, reason, updatedAt: new Date() }).where(eq(schema.messages.id, id));
      return { kind: 'done' as const, event: decisionEvent(m, status, reason) };
    };
    const tpl = m.templateId ? await publishedPushTemplate(tx, m.templateId, m.templateVersion) : null;
    if (!tpl?.template) return finish('failed', 'no_template: the template version is gone');
    const v = await checkPushRecipient(tx, ws, deps.kp, m.profileId ?? '', m.purpose);
    if (!v.ok) return finish('suppressed', v.reason);
    const hold = await checkPolicy(
      tx,
      ws,
      { ...m, profileId: v.profileId, channel: 'push', basis: v.basis, timezone: v.vars.timezone },
      await purposesOf(tx),
    );
    if (hold.ok === false) return finish('suppressed', hold.reason);
    if (hold.ok === 'later') return defer(tx, m, hold.until, hold.reason);
    let text: Awaited<ReturnType<typeof renderPush>>;
    try {
      text = await renderPush(tpl.template, { ...m.data, profile: v.vars });
    } catch (e) {
      return finish('failed', `render_error: ${(e as Error).message.split('\n')[0]}`);
    }
    const stream: 'marketing' | 'transactional' = isMarketing(v.basis) ? 'marketing' : 'transactional';
    const providers = (await tx.select().from(schema.pushProviders).where(eq(schema.pushProviders.enabled, true))).filter((p) =>
      p.useFor.includes(stream),
    );
    const providerFor = (kind: PushKind) => providers.find((p) => (pushAdapters[p.adapter].kinds as PushKind[]).includes(kind));
    const transports = new Map<string, Promise<PushTransport>>();
    const sends = [];
    for (const d of await devicesOf(tx, ws, v.profileId)) {
      const provider = providerFor(d.kind);
      if (!provider) continue;
      if (!transports.has(provider.id)) transports.set(provider.id, pushTransportFor(tx, provider, deps.kp, deps.email.adapterDeps));
      sends.push({
        device: d,
        provider,
        to: await openJson<PushRegistration>(tx, ws, deps.kp, d.secrets, d.secretsKeyId),
        transport: await (transports.get(provider.id) as Promise<PushTransport>),
      });
    }
    if (!sends.length)
      return finish('failed', `no_provider: no enabled push provider is set up for ${stream} messages to this person's devices`);
    const url = text.url
      ? deps.email.trackClicks
        ? `${deps.email.publicUrl}/c/${deps.email.links.sign({ w: ws, m: m.id, url: text.url } satisfies ClickLink)}`
        : text.url
      : null;
    return {
      kind: 'send' as const,
      m,
      sends,
      stream,
      out: {
        messageId: m.id,
        title: text.title,
        body: text.body,
        url,
        icon: tpl.template.icon ?? null,
        image: tpl.template.image ?? null,
        ttlSeconds: tpl.template.ttlHours * 3600,
        urgency: tpl.template.urgency,
      },
    };
  });

  if (prepared.kind === 'done') {
    await deps.events.insertMessageEvents([prepared.event]);
    return;
  }
  const { m, sends, out, stream } = prepared;
  const delivered: { device: string; id: string | null; provider: string; adapter: string }[] = [];
  const gone: string[] = [];
  const errors: string[] = [];
  for (const s of sends) {
    try {
      const r = await s.transport.send(s.to, out);
      if (r.ok) delivered.push({ device: s.device.id, id: r.providerMessageId, provider: s.provider.id, adapter: s.provider.adapter });
      else gone.push(s.device.id);
    } catch (e) {
      errors.push(`${s.provider.adapter}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  const event = await db.withWorkspace(ws, async (tx): Promise<MessageEvent> => {
    const s = schema.pushSubscriptions;
    if (gone.length) await tx.delete(s).where(inArray(s.id, gone));
    if (delivered.length)
      await tx
        .update(s)
        .set({ lastSentAt: new Date() })
        .where(
          inArray(
            s.id,
            delivered.map((d) => d.device),
          ),
        );
    if (delivered.length) {
      await tx
        .update(schema.messages)
        .set({
          status: 'sent',
          reason: errors.length ? `partly_sent: ${errors.join('; ')}`.slice(0, 500) : null,
          providerId: delivered[0].provider,
          providerMessageId: delivered[0].id,
          updatedAt: new Date(),
        })
        .where(eq(schema.messages.id, id));
      return decisionEvent(m, 'sent', '', delivered[0].adapter);
    }
    // Only errors: retried. Only gone devices: nothing left to send to.
    const retry = errors.length > 0 && m.attempts < MAX_ATTEMPTS;
    const reason = errors.length
      ? `provider_error: ${errors.join('; ')}`.slice(0, 500)
      : 'no_address: every registered device has unsubscribed';
    if (errors.length) logger.warn({ messageId: id, retry, errors }, 'push send failed');
    const nextAttemptAt = retry ? new Date(Date.now() + retryDelaySeconds(stream, m.attempts) * 1000) : null;
    await tx
      .update(schema.messages)
      .set({ status: retry ? 'queued' : errors.length ? 'failed' : 'suppressed', reason, nextAttemptAt, updatedAt: new Date() })
      .where(eq(schema.messages.id, id));
    return decisionEvent(m, retry ? 'queued' : errors.length ? 'failed' : 'suppressed', reason);
  });
  await deps.events.insertMessageEvents([event]);
}
