import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore, MessageEvent } from '@agentic-marketing/events';
import { profileForMessage, recordConsent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { DeliveryEvent } from './adapters';
import type { EmailServices } from './gateway';
import type { ClickLink, UnsubscribeLink } from './links';
import { transportFor, webhookTokenHash } from './providers';

// Public endpoints that e-mails and providers reach: delivery webhooks, one-click unsubscribe
// (RFC 8058) and click redirects. None of them needs a session; each is authenticated by a
// secret in its URL (webhooks) or a signed token (links).

export interface EmailRouteDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
  email: EmailServices;
}

type Msg = typeof schema.messages.$inferSelect;
const STATUS_ORDER = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained'];

function messageEvent(m: Msg, e: Pick<MessageEvent, 'eventId' | 'type' | 'at'> & Partial<MessageEvent>, provider: string): MessageEvent {
  return {
    workspaceId: m.workspaceId,
    messageId: m.id,
    profileId: m.profileId ?? '',
    channel: m.channel,
    purpose: m.purpose,
    provider,
    templateId: m.templateId ?? '',
    templateVersion: m.templateVersion ?? 0,
    journeyId: m.journeyId ?? '',
    reason: '',
    url: '',
    ...e,
  };
}

async function withdraw(tx: Tx, m: Msg, source: 'unsubscribe', proof: Record<string, unknown>, kp: KeyProvider) {
  if (!m.profileId) return;
  const person = await profileForMessage(tx, m.workspaceId, m.profileId, kp);
  if (!person) return;
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const basis = purposes.find((p) => p.key === m.purpose)?.basis ?? 'consent';
  // Under legitimate interest an unsubscribe is an objection; under consent, a withdrawal.
  await recordConsent(tx, m.workspaceId, person.id, purposes, [
    { purpose: m.purpose, channel: 'email', status: basis === 'legitimate_interest' ? 'objected' : 'withdrawn', source, proof },
  ]);
}

/** Applies a provider's delivery events to the message log, suppressions and consent. */
async function applyDeliveryEvents(tx: Tx, events: DeliveryEvent[], provider: string, kp: KeyProvider): Promise<MessageEvent[]> {
  const out: MessageEvent[] = [];
  for (const e of events) {
    const [m] = e.messageId
      ? await tx.select().from(schema.messages).where(eq(schema.messages.id, e.messageId))
      : e.providerMessageId
        ? await tx.select().from(schema.messages).where(eq(schema.messages.providerMessageId, e.providerMessageId))
        : [];
    if (!m) {
      logger.warn({ provider, event: e.type, providerMessageId: e.providerMessageId }, 'delivery event for an unknown message');
      continue;
    }
    const at = e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
    out.push(
      messageEvent(
        m,
        { eventId: e.eventId, type: e.type, at, reason: e.reason ?? (e.bounce ? `${e.bounce} bounce` : ''), url: e.url ?? '' },
        provider,
      ),
    );

    const next =
      e.type === 'delivered'
        ? 'delivered'
        : e.type === 'bounced' && e.bounce === 'hard'
          ? 'bounced'
          : e.type === 'complained'
            ? 'complained'
            : null;
    if (next && STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(m.status))
      await tx
        .update(schema.messages)
        .set({ status: next, reason: e.reason ?? m.reason, updatedAt: new Date() })
        .where(eq(schema.messages.id, m.id));
    if (m.recipientHash && ((e.type === 'bounced' && e.bounce === 'hard') || e.type === 'complained'))
      await tx
        .insert(schema.suppressions)
        .values({
          workspaceId: m.workspaceId,
          channel: 'email',
          valueHash: m.recipientHash,
          reason: e.type === 'complained' ? 'complaint' : 'hard_bounce',
        })
        .onConflictDoNothing();
    if (e.type === 'complained' || e.type === 'unsubscribed')
      await withdraw(tx, m, 'unsubscribe', { messageId: m.id, via: `${provider} ${e.type}` }, kp);
  }
  return out;
}

const page = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:Canvas;color:CanvasText}main{max-width:420px;margin:0 auto}button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #2f5bea;background:#2f5bea;color:#fff;cursor:pointer}p{opacity:.8}</style>
</head><body><main>${body}</main></body></html>`;

export function emailRoutes(deps: EmailRouteDeps) {
  const app = new Hono();

  app.post('/hooks/email/:id/:token', async (c) => {
    const { id, token } = c.req.param();
    const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM email_providers WHERE id = $1 AND webhook_token_hash = $2',
      [id, webhookTokenHash(token)],
    );
    if (!rows[0]) return c.json({ error: 'not_found' }, 404);
    const ws = rows[0].workspace_id;
    const req = { headers: Object.fromEntries(c.req.raw.headers), body: await c.req.text() };
    const result = await deps.db.withWorkspace(ws, async (tx) => {
      const [provider] = await tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.id, id));
      const transport = await transportFor(tx, provider, deps.kp, deps.email.adapterDeps);
      try {
        if (!transport.parseWebhook) return { status: 400 as const, events: [] };
        if (transport.verifyWebhook && !(await transport.verifyWebhook(req))) return { status: 401 as const, events: [] };
        let parsed: DeliveryEvent[];
        try {
          parsed = await transport.parseWebhook(req);
        } catch {
          return { status: 400 as const, events: [] };
        }
        return { status: 200 as const, events: await applyDeliveryEvents(tx, parsed, provider.adapter, deps.kp) };
      } finally {
        await transport.close?.();
      }
    });
    await deps.events.insertMessageEvents(result.events);
    return c.json({ ok: result.status === 200, events: result.events.length }, result.status);
  });

  const unsubscribe = async (token: string) => {
    const link = deps.email.links.verify<UnsubscribeLink>(token);
    if (!link) return false;
    const recorded = await deps.db.withWorkspace(link.w, async (tx) => {
      const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, link.m));
      const msg: Msg =
        m ??
        ({
          workspaceId: link.w,
          id: link.m,
          profileId: link.p,
          purpose: link.u,
          channel: 'email',
          templateId: null,
          templateVersion: null,
          journeyId: null,
        } as Msg);
      await withdraw(tx, msg, 'unsubscribe', { messageId: link.m, via: 'unsubscribe link' }, deps.kp);
      return messageEvent(msg, { eventId: 'unsubscribe-link', type: 'unsubscribed', at: new Date().toISOString() }, '');
    });
    await deps.events.insertMessageEvents([recorded]);
    return true;
  };

  app.get('/u/:token', (c) => {
    if (!deps.email.links.verify(c.req.param('token')))
      return c.html(page('Link not valid', '<h1>This link is not valid</h1><p>Use the unsubscribe link from a recent e-mail.</p>'), 404);
    return c.html(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe?</h1><p>You will no longer receive these e-mails.</p><form method="post"><button>Unsubscribe</button></form>`,
      ),
    );
  });
  // Mail clients POST here directly (RFC 8058 one-click); the page's button does the same.
  app.post('/u/:token', async (c) => {
    if (!(await unsubscribe(c.req.param('token')))) return c.html(page('Link not valid', '<h1>This link is not valid</h1>'), 404);
    return c.html(
      page(
        'Unsubscribed',
        '<h1>You are unsubscribed</h1><p>It can take a moment before running campaigns notice. Sorry for the noise.</p>',
      ),
    );
  });

  app.get('/c/:token', async (c) => {
    const link = deps.email.links.verify<ClickLink>(c.req.param('token'));
    if (!link || !/^https?:\/\//.test(link.url)) return c.text('This link is not valid.', 404);
    try {
      const ev = await deps.db.withWorkspace(link.w, async (tx) => {
        const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, link.m));
        return m
          ? messageEvent(
              m,
              {
                eventId: `click:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
                type: 'clicked',
                at: new Date().toISOString(),
                url: link.url,
              },
              '',
            )
          : null;
      });
      if (ev) await deps.events.insertMessageEvents([ev]);
    } catch (err) {
      // Never break the click for the reader.
      logger.warn({ err }, 'click tracking failed');
    }
    return c.redirect(link.url, 302);
  });

  return app;
}
