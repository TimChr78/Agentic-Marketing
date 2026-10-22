import { DEFAULT_PURPOSES, type EmailTemplate, publishedSingleton } from '@agentic-marketing/artifacts';
import { newId, newUuid } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore, MessageEvent } from '@agentic-marketing/events';
import { consentStateOf, profileForMessage, purposeAllowed } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, lt, sql } from 'drizzle-orm';
import { type AdapterDeps, MESSAGE_ID_HEADER } from './adapters';
import { applyDeliveryEvents } from './deliveryEvents';
import { type ClickLink, type LinkSigner, tagLinks, trackLinks, type UnsubscribeLink } from './links';
import { decisionEvent, defer, MAX_ATTEMPTS } from './outbox';
import { checkPolicy } from './policy';
import { transportFor } from './providers';
import { renderTemplate } from './render';
import { deliverSms } from './sms/gateway';

// The send gateway (ADR-0007). Every e-mail is requested here and goes out through an outbox:
// `requestEmail` decides (lawful basis, suppression, address) and records the message; the
// delivery worker re-checks, renders and hands it to the provider. Every decision, including
// "not sent because …", is in the message log and in ClickHouse.

export interface EmailServices {
  publicUrl: string;
  links: LinkSigner;
  adapterDeps: AdapterDeps;
  /** Click tracking (on by default, ADR: clicks on, open pixels off). */
  trackClicks: boolean;
}

declare module '@agentic-marketing/commands' {
  interface Services {
    email: EmailServices;
  }
}

export interface EmailRequest {
  profileId: string;
  templateId: string;
  idempotencyKey?: string;
  journeyId?: string;
  data?: Record<string, unknown>;
}

export interface Decision {
  messageId: string;
  status: 'queued' | 'suppressed' | 'failed' | 'sent' | 'sending' | 'delivered' | 'bounced' | 'complained';
  reason: string | null;
  duplicate: boolean;
}

const streamOf = (basis: string) => (basis === 'contract' || basis === 'legal_obligation' ? 'transactional' : 'marketing');

async function purposesOf(tx: Tx) {
  return (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
}

async function publishedTemplate(tx: Tx, templateId: string) {
  const [row] = await tx
    .select({ version: schema.artifacts.publishedVersion, type: schema.artifacts.type, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .leftJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  if (row?.type !== 'email_template') return null;
  return row.version && row.content ? { version: row.version, template: row.content as EmailTemplate } : { version: null, template: null };
}

type Verdict =
  | { ok: true; email: string; emailHash: string; vars: Record<string, unknown>; basis: string; profileId: string }
  | { ok: false; reason: string };

/** Lawful basis, address and suppression for one person and purpose. */
export async function checkRecipient(tx: Tx, workspaceId: string, kp: KeyProvider, profileId: string, purpose: string): Promise<Verdict> {
  const person = await profileForMessage(tx, workspaceId, profileId, kp);
  if (!person) return { ok: false, reason: 'no_profile: the person does not exist (or was erased)' };
  if (!person.email || !person.emailHash) return { ok: false, reason: 'no_address: no e-mail address is known for this person' };
  const p = (await purposesOf(tx)).find((x) => x.key === purpose);
  if (!p) return { ok: false, reason: `unknown_purpose: "${purpose}" is not a configured purpose` };
  const state = (await consentStateOf(tx, workspaceId, person.id))
    .filter((s) => s.purpose === purpose && (s.channel === '' || s.channel === 'email'))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (!purposeAllowed(p.basis, state?.status))
    return {
      ok: false,
      reason: `no_lawful_basis: purpose "${purpose}" is based on ${p.basis.replace('_', ' ')} and the person's status is ${state?.status ?? 'unknown (no record)'}`,
    };
  const [sup] = await tx
    .select()
    .from(schema.suppressions)
    .where(and(eq(schema.suppressions.channel, 'email'), eq(schema.suppressions.valueHash, person.emailHash)));
  if (sup) return { ok: false, reason: `suppressed: the address is on the suppression list (${sup.reason})` };
  return { ok: true, email: person.email, emailHash: person.emailHash, vars: person.vars, basis: p.basis, profileId: person.id };
}

/**
 * Records a send request and decides it. Returns the earlier decision for a repeated
 * idempotency key. Queued messages are sent by the delivery worker.
 */
export async function requestEmail(tx: Tx, workspaceId: string, kp: KeyProvider, events: EventStore, req: EmailRequest): Promise<Decision> {
  const key = req.idempotencyKey ?? newUuid();
  const [existing] = await tx.select().from(schema.messages).where(eq(schema.messages.idempotencyKey, key));
  if (existing) return { messageId: existing.id, status: existing.status, reason: existing.reason, duplicate: true };

  const tpl = await publishedTemplate(tx, req.templateId);
  const purpose = tpl?.template?.purpose ?? 'unknown';
  let status: Decision['status'] = 'queued';
  let reason: string | null = null;
  let profileId = req.profileId;
  let recipientHash: string | null = null;
  if (!tpl) [status, reason] = ['failed', `no_template: ${req.templateId} is not an e-mail template in this workspace`];
  else if (!tpl.template) [status, reason] = ['failed', `not_published: template ${req.templateId} has no published version`];
  else {
    const v = await checkRecipient(tx, workspaceId, kp, req.profileId, purpose);
    if (!v.ok) [status, reason] = ['suppressed', v.reason];
    else [profileId, recipientHash] = [v.profileId, v.emailHash];
  }
  const [m] = await tx
    .insert(schema.messages)
    .values({
      workspaceId,
      id: newId('msg'),
      idempotencyKey: key,
      profileId,
      purpose,
      templateId: req.templateId,
      templateVersion: tpl?.version ?? null,
      journeyId: req.journeyId ?? null,
      status,
      reason,
      recipientHash,
      data: req.data ?? {},
    })
    .returning();
  await events.insertMessageEvents([decisionEvent(m, status, reason ?? '')]);
  return { messageId: m.id, status, reason, duplicate: false };
}

const STALE_SENDING_MS = 10 * 60_000;

/**
 * One round of the delivery worker: claims queued messages per workspace, re-checks the
 * recipient, renders, sends, and records the outcome. Returns how many it handled.
 */
export async function deliverRound(
  db: Db,
  deps: { kp: KeyProvider; events: EventStore; email: EmailServices; batch?: number },
): Promise<number> {
  const { rows: workspaces } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM messages WHERE status IN ('queued', 'sending') LIMIT 100`,
  );
  let handled = 0;
  for (const { workspace_id: ws } of workspaces) {
    // A message stuck in "sending" means a worker stopped mid-send: the outcome is unknown, and
    // sending again could duplicate it, so it is marked failed for a person to look at.
    await db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.messages)
        .set({
          status: 'failed',
          reason: 'unknown_outcome: the worker stopped while sending; check the provider before resending',
          updatedAt: new Date(),
        })
        .where(and(eq(schema.messages.status, 'sending'), lt(schema.messages.updatedAt, new Date(Date.now() - STALE_SENDING_MS)))),
    );
    const claimed = await db.withWorkspace(ws, async (tx) => {
      const res = await tx.execute<{ id: string; channel: string }>(sql`
        UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
        WHERE (workspace_id, id) IN (
          SELECT workspace_id, id FROM messages
          WHERE status = 'queued' AND updated_at <= now() - make_interval(secs => 30 * attempts * attempts)
            AND (not_before IS NULL OR not_before <= now())
          ORDER BY created_at LIMIT ${deps.batch ?? 50} FOR UPDATE SKIP LOCKED)
        RETURNING id, channel`);
      return res.rows;
    });
    for (const { id, channel } of claimed) {
      if (channel === 'sms') await deliverSms(db, ws, id, deps);
      else await deliverOne(db, ws, id, deps);
      handled++;
    }
  }
  return handled;
}

async function deliverOne(db: Db, ws: string, id: string, deps: { kp: KeyProvider; events: EventStore; email: EmailServices }) {
  type Prepared =
    | { kind: 'done'; event: MessageEvent }
    | {
        kind: 'send';
        m: typeof schema.messages.$inferSelect;
        provider: typeof schema.emailProviders.$inferSelect;
        transport: Awaited<ReturnType<typeof transportFor>>;
        out: Parameters<Awaited<ReturnType<typeof transportFor>>['send']>[0];
      };

  const prepared: Prepared = await db.withWorkspace(ws, async (tx) => {
    const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, id));
    const finish = async (status: 'suppressed' | 'failed', reason: string): Promise<Prepared> => {
      await tx.update(schema.messages).set({ status, reason, updatedAt: new Date() }).where(eq(schema.messages.id, id));
      return { kind: 'done', event: decisionEvent(m, status, reason) };
    };
    const tpl = m.templateId ? await publishedTemplateVersion(tx, m.templateId, m.templateVersion) : null;
    if (!tpl) return finish('failed', 'no_template: the template version is gone');
    const v = await checkRecipient(tx, ws, deps.kp, m.profileId ?? '', m.purpose);
    if (!v.ok) return finish('suppressed', v.reason);
    const hold = await checkPolicy(
      tx,
      ws,
      { ...m, profileId: v.profileId, channel: 'email', basis: v.basis, timezone: v.vars.timezone },
      await purposesOf(tx),
    );
    if (hold.ok === false) return finish('suppressed', hold.reason);
    if (hold.ok === 'later') return defer(tx, m, hold.until, hold.reason);
    const stream = streamOf(v.basis);
    const providers = await tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.enabled, true));
    const provider = providers.find((p) => p.useFor.includes(stream));
    if (!provider) return finish('failed', `no_provider: no enabled e-mail provider is set up for ${stream} messages`);

    const unsubscribe = `${deps.email.publicUrl}/u/${deps.email.links.sign({ w: ws, p: v.profileId, u: m.purpose, m: m.id } satisfies UnsubscribeLink)}`;
    let rendered: Awaited<ReturnType<typeof renderTemplate>>;
    try {
      rendered = await renderTemplate(tpl, { ...m.data, profile: v.vars, unsubscribe_url: unsubscribe, preferences_url: unsubscribe });
    } catch (e) {
      return finish('failed', `render_error: ${(e as Error).message.split('\n')[0]}`);
    }
    const tagged = tpl.utm ? tagLinks(rendered.html, tpl.utm, [deps.email.publicUrl]) : rendered.html;
    const html = deps.email.trackClicks
      ? trackLinks(tagged, (url) => `${deps.email.publicUrl}/c/${deps.email.links.sign({ w: ws, m: m.id, url } satisfies ClickLink)}`, [
          unsubscribe,
        ])
      : tagged;
    const headers: Record<string, string> = { [MESSAGE_ID_HEADER]: m.id };
    if (stream === 'marketing') {
      headers['List-Unsubscribe'] = `<${unsubscribe}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    return {
      kind: 'send',
      m,
      provider,
      transport: await transportFor(tx, provider, deps.kp, deps.email.adapterDeps),
      out: {
        messageId: m.id,
        from: { email: provider.fromEmail, name: provider.fromName || undefined },
        replyTo: provider.replyTo ?? undefined,
        to: v.email,
        subject: rendered.subject,
        html,
        text: rendered.text,
        headers,
        stream,
      },
    };
  });

  if (prepared.kind === 'done') {
    await deps.events.insertMessageEvents([prepared.event]);
    return;
  }
  const { m, provider, transport, out } = prepared;
  let event: MessageEvent;
  let reported: MessageEvent[] = [];
  try {
    const { providerMessageId, events: known } = await transport.send(out);
    await db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.messages)
        .set({ status: 'sent', reason: null, providerId: provider.id, providerMessageId, updatedAt: new Date() })
        .where(eq(schema.messages.id, id)),
    );
    event = decisionEvent(m, 'sent', '', provider.adapter);
    if (known?.length) reported = await db.withWorkspace(ws, (tx) => applyDeliveryEvents(tx, known, provider.adapter, deps.kp));
  } catch (e) {
    const reason = `provider_error: ${(e as Error).message.split('\n')[0]}`;
    const retry = m.attempts < MAX_ATTEMPTS;
    logger.warn({ messageId: id, provider: provider.adapter, retry, err: (e as Error).message }, 'e-mail send failed');
    await db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.messages)
        .set({ status: retry ? 'queued' : 'failed', reason, providerId: provider.id, updatedAt: new Date() })
        .where(eq(schema.messages.id, id)),
    );
    event = decisionEvent(m, retry ? 'queued' : 'failed', reason, provider.adapter);
  } finally {
    await transport.close?.();
  }
  await deps.events.insertMessageEvents([event, ...reported]);
}

async function publishedTemplateVersion(tx: Tx, templateId: string, version: number | null) {
  if (!version) return null;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, templateId), eq(schema.artifactVersions.number, version)));
  return (v?.content as EmailTemplate | undefined) ?? null;
}

/** Runs delivery rounds until `signal` aborts; pauses briefly when there is nothing to do. */
export async function runDeliveryWorker(db: Db, deps: { kp: KeyProvider; events: EventStore; email: EmailServices }, signal: AbortSignal) {
  while (!signal.aborted) {
    let handled = 0;
    try {
      handled = await deliverRound(db, deps);
    } catch (err) {
      logger.error({ err }, 'delivery round failed');
    }
    if (!handled) await new Promise((r) => setTimeout(r, 500));
  }
}
