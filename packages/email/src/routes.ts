import {
  type BrandCopy,
  HOSTED_PAGE_HEADERS,
  type HostedPageKind,
  publishedSingleton,
  renderHostedPage,
  resolveBrand,
} from '@agentic-marketing/artifacts';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import type { DeliveryEvent } from './adapters';
import { applyDeliveryEvents, type Msg, messageEvent, withdraw } from './deliveryEvents';
import type { EmailServices } from './gateway';
import type { ClickLink, UnsubscribeLink } from './links';
import { transportFor, webhookTokenHash } from './providers';
import { smsRoutes } from './sms/routes';

// Public endpoints that e-mails and providers reach: delivery webhooks, one-click unsubscribe
// (RFC 8058) and click redirects. None of them needs a session; each is authenticated by a
// secret in its URL (webhooks) or a signed token (links).

export interface EmailRouteDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
  email: EmailServices;
}

export function emailRoutes(deps: EmailRouteDeps) {
  const app = new Hono();
  app.route('/', smsRoutes(deps));

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

  /** The published brand for the workspace a link belongs to; drafts never render. */
  const hostedPage = async (kind: HostedPageKind, workspaceId: string | null, copy?: Partial<BrandCopy>) => {
    const brand = workspaceId ? await deps.db.withWorkspace(workspaceId, (tx) => publishedSingleton(tx, 'brand')) : null;
    return renderHostedPage(kind, resolveBrand(brand), { copy });
  };
  const hosted = (c: Context, html: string, status: 200 | 404) => c.html(html, status, HOSTED_PAGE_HEADERS);
  const invalidLink = {
    expiredTitle: 'This link is not valid',
    expiredBody: 'Use the unsubscribe link from a recent e-mail.',
  };

  const unsubscribe = async (token: string) => {
    const link = deps.email.links.verify<UnsubscribeLink>(token);
    if (!link) return null;
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
    return link;
  };

  app.get('/u/:token', async (c) => {
    const link = deps.email.links.verify<UnsubscribeLink>(c.req.param('token'));
    if (!link) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    return hosted(c, await hostedPage('unsubscribe', link.w), 200);
  });
  // Mail clients POST here directly (RFC 8058 one-click); the page's button does the same.
  app.post('/u/:token', async (c) => {
    const link = await unsubscribe(c.req.param('token'));
    if (!link) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    return hosted(c, await hostedPage('unsubscribed', link.w), 200);
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
