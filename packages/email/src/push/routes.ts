import { sha256 } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import { originAllowed, sourceLookups, writeKeyOf } from '@agentic-marketing/ingest';
import { type KeyProvider, sealJson } from '@agentic-marketing/secrets';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PushRegistration } from './adapters';

// Public push endpoints, with a write key like /v1/batch:
//   GET  /v1/push/config       the VAPID public key browsers subscribe with
//   POST /v1/push/subscribe    a browser subscription or an app's FCM/APNs token, for an anonymous and/or user id
//   POST /v1/push/unsubscribe  forget a device
// From browser keys only the anonymous id is taken; app backends bind user ids with a server key.
// Registrations are sealed with the workspace key; only a hash of the endpoint or token is
// stored in the clear, to find the device again. Consent is separate: the SDK records the
// purpose the visitor agreed to (e.g. marketing_push) as a consent event when it subscribes.

const Id = z.string().min(1).max(200);
const Subscribe = z
  .object({
    anonymousId: Id.optional(),
    userId: Id.optional(),
    subscription: z
      .object({
        endpoint: z
          .url({ protocol: /^https?$/ })
          .max(2000)
          .describe('The push service URL; the egress guard applies when sending'),
        keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }),
      })
      .optional()
      .describe('A browser PushSubscription (toJSON())'),
    kind: z.enum(['fcm', 'apns']).optional(),
    token: z.string().min(16).max(4096).optional().describe('An app registration token (FCM) or device token (APNs, hex)'),
  })
  .refine((b) => !!b.anonymousId || !!b.userId, 'Give anonymousId or userId')
  .refine((b) => !!b.subscription !== !!(b.kind && b.token), 'Give a browser subscription, or kind and token');
const Unsubscribe = z
  .object({ endpoint: z.string().max(2000).optional(), token: z.string().max(4096).optional() })
  .refine((b) => !!b.endpoint !== !!b.token, 'Give endpoint or token');

const tokenHash = (endpointOrToken: string) => sha256(`push:${endpointOrToken}`);

export function pushRoutes(deps: { db: Db; kp: KeyProvider }) {
  const { loadSource } = sourceLookups(deps.db);
  const app = new Hono();
  const cors = (origin: string | undefined): Record<string, string> =>
    origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};

  app.options('/v1/push/:op{config|subscribe|unsubscribe}', (c) =>
    c.body(null, 204, {
      'access-control-allow-origin': c.req.header('origin') ?? '*',
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      vary: 'origin',
    }),
  );

  const authorize = async (c: Parameters<typeof writeKeyOf>[0], body: Record<string, unknown>) => {
    const key = writeKeyOf(c, body) ?? c.req.query('writeKey');
    const source = key ? await loadSource(key) : null;
    if (!source?.enabled) return { error: 401 as const, message: 'Unknown or disabled write key.' };
    if (!originAllowed(source, c.req.header('origin'))) return { error: 403 as const, message: 'This origin may not use the write key.' };
    return { source };
  };

  app.get('/v1/push/config', async (c) => {
    const origin = c.req.header('origin');
    const a = await authorize(c, {});
    if ('error' in a) return c.json({ error: 'unauthorized', message: a.message }, a.error, cors(origin));
    const [web] = await deps.db.withWorkspace(a.source.workspaceId, (tx) =>
      tx
        .select({ publicKey: sql<string>`${schema.pushProviders.config} ->> 'publicKey'` })
        .from(schema.pushProviders)
        .where(and(eq(schema.pushProviders.adapter, 'webpush'), eq(schema.pushProviders.enabled, true)))
        .orderBy(schema.pushProviders.createdAt)
        .limit(1),
    );
    return c.json({ webPush: web ? { publicKey: web.publicKey } : null }, 200, { ...cors(origin), 'cache-control': 'max-age=300' });
  });

  app.post('/v1/push/:op{subscribe|unsubscribe}', async (c) => {
    const origin = c.req.header('origin');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400, cors(origin));
    }
    const a = await authorize(c, body);
    if ('error' in a) return c.json({ error: 'unauthorized', message: a.message }, a.error, cors(origin));
    const ws = a.source.workspaceId;
    const s = schema.pushSubscriptions;

    if (c.req.param('op') === 'unsubscribe') {
      const u = Unsubscribe.safeParse(body);
      if (!u.success) return c.json({ error: 'invalid_input', message: z.prettifyError(u.error) }, 400, cors(origin));
      await deps.db.withWorkspace(ws, (tx) => tx.delete(s).where(inArray(s.tokenHash, [tokenHash(u.data.endpoint ?? u.data.token ?? '')])));
      return c.json({ ok: true }, 200, cors(origin));
    }

    const p = Subscribe.safeParse(body);
    if (!p.success) return c.json({ error: 'invalid_input', message: z.prettifyError(p.error) }, 400, cors(origin));
    const { subscription, kind, token, anonymousId } = p.data;
    // A browser key is public: from it, a device may only be registered for its own anonymous id
    // (the person follows through identity resolution). Binding a user id takes a server key,
    // or anyone could have someone else's notifications sent to their browser.
    const browser = a.source.kind === 'browser';
    if (browser && !anonymousId)
      return c.json({ error: 'invalid_input', message: 'From a browser key, give the anonymousId.' }, 400, cors(origin));
    const userId = browser ? undefined : p.data.userId;
    const reg: PushRegistration = subscription
      ? { kind: 'web', endpoint: subscription.endpoint, ...subscription.keys }
      : { kind: kind as 'fcm' | 'apns', token: token as string };
    const hash = tokenHash(subscription?.endpoint ?? (token as string));
    await deps.db.withWorkspace(ws, async (tx) => {
      const sealed = await sealJson(tx, ws, deps.kp, reg);
      const values = {
        kind: reg.kind,
        anonymousId: anonymousId ?? null,
        userId: userId ?? null,
        secrets: sealed.blob,
        secretsKeyId: sealed.keyId,
        sourceId: a.source.id,
        updatedAt: new Date(),
      };
      // The same device registered again (another person signed in on it): it now belongs to them.
      await tx
        .insert(s)
        .values({ workspaceId: ws, id: `psb_${hash.slice(0, 32)}`, tokenHash: hash, ...values })
        .onConflictDoUpdate({ target: [s.workspaceId, s.tokenHash], set: values });
    });
    return c.json({ ok: true }, 200, cors(origin));
  });

  return app;
}
