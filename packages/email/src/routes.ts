import {
  type BrandCopy,
  DEFAULT_PURPOSES,
  HOSTED_PAGE_HEADERS,
  type HostedPageKind,
  type PreferencePurpose,
  publishedSingleton,
  renderHostedPage,
  renderPreferencesPage,
  resolveBrand,
} from '@agentic-marketing/artifacts';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { effectiveTopicStatus, findTopic, recordTopicPreference, topicChoicesOf } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import type { DeliveryEvent } from './adapters';
import { applyDeliveryEvents, type Msg, messageEvent, withdraw } from './deliveryEvents';
import type { EmailServices } from './gateway';
import type { ClickLink, TopicLink, UnsubscribeLink } from './links';
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
  /** Called after consent changed outside the event stream (unsubscribes), e.g. to update segments. */
  consentChanged?: (workspaceId: string, profileIds: string[], cause: string) => Promise<void>;
}

export function emailRoutes(deps: EmailRouteDeps) {
  const app = new Hono();
  // Best effort: the unsubscribe is recorded either way, and the segment scheduler catches up.
  const consentChanged = async (ws: string, people: string[], cause: string) => {
    if (!deps.consentChanged || !people.length) return;
    await deps
      .consentChanged(ws, people, cause)
      .catch((err) => logger.warn({ err, workspace: ws }, 'segment update after unsubscribe failed'));
  };
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
    for (const e of result.events)
      if ((e.type === 'unsubscribed' || e.type === 'complained') && e.profileId)
        await consentChanged(ws, [e.profileId], `unsubscribe:${e.messageId}`);
    return c.json({ ok: result.status === 200, events: result.events.length }, result.status);
  });

  /** The published brand for the workspace a link belongs to; drafts never render. */
  const hostedPage = async (
    kind: HostedPageKind,
    workspaceId: string | null,
    opts: { copy?: Partial<BrandCopy>; manageUrl?: string | null } = {},
  ) => {
    const brand = workspaceId ? await deps.db.withWorkspace(workspaceId, (tx) => publishedSingleton(tx, 'brand')) : null;
    return renderHostedPage(kind, resolveBrand(brand), opts);
  };
  const hosted = (c: Context, html: string, status: 200 | 404) => c.html(html, status, HOSTED_PAGE_HEADERS);
  const invalidLink = {
    copy: { expiredTitle: 'This link is not valid', expiredBody: 'Use the unsubscribe link from a recent e-mail.' },
  };
  const purposesOf = async (ws: string) =>
    deps.db.withWorkspace(ws, async (tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES);
  const profileExists = (ws: string, profileId: string) =>
    deps.db.withWorkspace(ws, async (tx) => {
      const [row] = await tx
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(and(eq(schema.profiles.workspaceId, ws), eq(schema.profiles.id, profileId)));
      return !!row;
    });

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
    if (recorded.profileId) await consentChanged(link.w, [recorded.profileId], `unsubscribe:${link.m}`);
    return link;
  };

  /** The marketing purposes with topics a person can choose about, with their effective status. */
  const preferencePurposes = async (ws: string, profileId: string): Promise<PreferencePurpose[]> => {
    const { purposes, choices } = await deps.db.withWorkspace(ws, async (tx) => ({
      purposes: (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES,
      choices: await topicChoicesOf(tx, ws, profileId),
    }));
    return purposes
      .filter((p) => p.basis !== 'contract' && p.basis !== 'legal_obligation' && (p.topics ?? []).length > 0)
      .map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        topics: (p.topics ?? []).map((t) => ({
          key: t.key,
          name: t.name,
          description: t.description,
          status: effectiveTopicStatus(choices, t),
        })),
      }));
  };
  const preferenceToken = (token: string) => deps.email.links.verify<UnsubscribeLink>(token);
  const topicToken = (token: string) => {
    const link = deps.email.links.verify<TopicLink>(token);
    return link?.topic ? link : null;
  };
  /** The topic's display name, only when it really belongs to the purpose in the token. */
  const topicOf = async (ws: string, purpose: string, topic: string) => {
    const found = findTopic(await purposesOf(ws), topic);
    return found?.purpose.key === purpose ? found.topic : null;
  };

  app.get('/u/:token', async (c) => {
    const link = deps.email.links.verify<UnsubscribeLink>(c.req.param('token'));
    if (!link) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    return hosted(c, await hostedPage('unsubscribe', link.w), 200);
  });
  // Mail clients POST here directly (RFC 8058 one-click); the page's button does the same.
  app.post('/u/:token', async (c) => {
    const token = c.req.param('token');
    const link = await unsubscribe(token);
    if (!link) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    return hosted(c, await hostedPage('unsubscribed', link.w, { manageUrl: `${deps.email.publicUrl}/u/p/${token}` }), 200);
  });

  // The preference centre (#84): a GET only shows choices; the POST is the only thing that saves.
  // The token is the same signed payload as the unsubscribe link, so mail scanners that follow
  // links cannot change anything.
  app.get('/u/p/:token', async (c) => {
    const link = preferenceToken(c.req.param('token'));
    if (!link || !(await profileExists(link.w, link.p))) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    const brand = await deps.db.withWorkspace(link.w, (tx) => publishedSingleton(tx, 'brand'));
    const purposes = await preferencePurposes(link.w, link.p);
    return hosted(c, renderPreferencesPage(resolveBrand(brand), { action: '', purposes }), 200);
  });
  app.post('/u/p/:token', async (c) => {
    const token = c.req.param('token');
    const link = preferenceToken(token);
    if (!link || !(await profileExists(link.w, link.p))) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    const body = await c.req.parseBody();
    const action = typeof body.action === 'string' ? body.action : '';
    // "Unsubscribe from all marketing" is the one-click unsubscribe link's own behaviour.
    if (action === 'unsubscribe_all') {
      const done = await unsubscribe(token);
      if (!done) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
      return hosted(c, await hostedPage('unsubscribed', done.w, { manageUrl: `${deps.email.publicUrl}/u/p/${token}` }), 200);
    }
    const purposes = (await purposesOf(link.w)).filter(
      (p) => p.basis !== 'contract' && p.basis !== 'legal_obligation' && (p.topics ?? []).length > 0,
    );
    const choices = await deps.db.withWorkspace(link.w, (tx) => topicChoicesOf(tx, link.w, link.p));
    const changes: { purpose: string; topic: string; status: 'subscribed' | 'unsubscribed' }[] = [];
    for (const purpose of purposes)
      for (const topic of purpose.topics ?? []) {
        const next = body[`topic:${topic.key}`] === 'subscribed' ? 'subscribed' : 'unsubscribed';
        if (next !== effectiveTopicStatus(choices, topic)) changes.push({ purpose: purpose.key, topic: topic.key, status: next });
      }
    if (changes.length) {
      await deps.db.withWorkspace(link.w, async (tx) => {
        for (const change of changes)
          await recordTopicPreference(tx, link.w, link.p, change.purpose, change.topic, change.status, 'preference_center', {
            note: 'Changed on the preference centre',
            proof: { page: 'preference_center' },
          });
      });
      await consentChanged(link.w, [link.p], `preferences:${link.p}`);
    }
    const brand = await deps.db.withWorkspace(link.w, (tx) => publishedSingleton(tx, 'brand'));
    return hosted(
      c,
      renderPreferencesPage(resolveBrand(brand), { action: '', purposes: await preferencePurposes(link.w, link.p), saved: true }),
      200,
    );
  });

  // A topic link only turns that finer choice off; the purpose's consent is untouched.
  app.get('/u/t/:token', async (c) => {
    const link = topicToken(c.req.param('token'));
    if (!link || !(await profileExists(link.w, link.p))) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    const topic = await topicOf(link.w, link.u, link.topic);
    if (!topic) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    return hosted(
      c,
      await hostedPage('unsubscribe', link.w, {
        copy: {
          unsubscribeTitle: `Unsubscribe from ${topic.name}`,
          unsubscribeBody: `You will no longer receive e-mails about ${topic.name}. Your other choices stay as they are.`,
          unsubscribeButton: `Unsubscribe from ${topic.name}`,
        },
      }),
      200,
    );
  });
  app.post('/u/t/:token', async (c) => {
    const token = c.req.param('token');
    const link = topicToken(token);
    if (!link || !(await profileExists(link.w, link.p))) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    const topic = await topicOf(link.w, link.u, link.topic);
    if (!topic) return hosted(c, await hostedPage('expired', null, invalidLink), 404);
    await deps.db.withWorkspace(link.w, (tx) =>
      recordTopicPreference(tx, link.w, link.p, link.u, topic.key, 'unsubscribed', 'unsubscribe_link', {
        proof: { messageId: link.m, via: 'topic unsubscribe link' },
      }),
    );
    await consentChanged(link.w, [link.p], `topic-unsubscribe:${link.m}`);
    return hosted(
      c,
      await hostedPage('unsubscribed', link.w, {
        copy: {
          unsubscribedTitle: `Unsubscribed from ${topic.name}`,
          unsubscribedBody: `You will no longer receive e-mails about ${topic.name}.`,
        },
        manageUrl: `${deps.email.publicUrl}/u/p/${token}`,
      }),
      200,
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
