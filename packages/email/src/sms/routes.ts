import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import type { PublicRequest } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { bodyLimit } from '@agentic-marketing/ingest';
import { personCrypto, recordConsent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { applyDeliveryEvents } from '../deliveryEvents';
import type { EmailServices } from '../gateway';
import { isMarketing } from '../policy';
import { classifySmsReply } from './keywords';
import { billingOf, smsTransportFor } from './providers';

export { HELP_WORDS, START_WORDS, STOP_WORDS } from './keywords';

// Public SMS endpoints: delivery status callbacks and inbound texts. The path carries a signed
// token naming the workspace and provider; the provider's own signature is checked as well.
// STOP-type keywords withdraw consent for marketing texts and suppress the number (carriers stop
// all texts from a sender after STOP); START removes the suppression; HELP gets the help text.

// Provider callbacks carry one message plus metadata; 64 KB is comfortably above every adapter's
// payload while still bounding the unauthenticated endpoint.
const SMS_INBOUND_MAX_BODY = 64 * 1024;

interface Deps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
  email: EmailServices;
}

async function profilesWithPhone(tx: Tx, ws: string, kp: KeyProvider, phone: string) {
  const hash = await personCrypto(tx, ws, kp).matchHash('phone', phone);
  const rows = await tx
    .select({ profileId: schema.identifiers.profileId })
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.type, 'phone'), eq(schema.identifiers.value, hash)));
  return { hash, profileIds: rows.map((r) => r.profileId) };
}

export function smsRoutes(deps: Deps) {
  const app = new Hono<{ Variables: { publicRequest?: PublicRequest } }>();

  const load = async (token: string) => {
    const t = deps.email.links.verify<{ w: string; sms: string }>(token);
    if (!t?.w || !t.sms) return null;
    return { ws: t.w, id: t.sms };
  };

  app.post(
    '/hooks/sms/:token/:kind{status|inbound}',
    bodyLimit(SMS_INBOUND_MAX_BODY, (c) => c.json({ error: 'payload_too_large' }, 413)),
    async (c) => {
      const target = await load(c.req.param('token'));
      if (!target) return c.json({ error: 'not_found' }, 404);
      // The callback URL belongs to its brand; another brand's host must not deliver it.
      const request = c.get('publicRequest');
      if (request?.workspaceId && request.workspaceId !== target.ws) return c.json({ error: 'not_found' }, 404);
      const kind = c.req.param('kind');
      // Signature validation must see the URL the provider called, not the workspace's current
      // primary domain: callbacks configured before a primary change keep working (#457). The
      // middleware already resolved the host (and stripped a registered path prefix), so rebuild
      // from the trusted public request context.
      const called = new URL(c.req.url);
      const url = request
        ? `${request.linksUrl}${c.req.path}${called.search}`
        : `${(await deps.email.publicUrlFor?.(target.ws)) ?? deps.email.publicUrl}${c.req.path}${called.search}`;
      const req = {
        url,
        headers: Object.fromEntries(c.req.raw.headers),
        body: await c.req.text(),
      };
      const result = await deps.db.withWorkspace(target.ws, async (tx) => {
        const [provider] = await tx.select().from(schema.smsProviders).where(eq(schema.smsProviders.id, target.id));
        if (!provider) return { status: 404 as const };
        const transport = await smsTransportFor(tx, provider, deps.kp, deps.email.adapterDeps);
        if (!transport.verifyWebhook(req)) return { status: 401 as const };

        if (kind === 'status')
          return { status: 200 as const, events: await applyDeliveryEvents(tx, transport.parseStatus(req), provider.adapter, deps.kp) };

        const inbound = transport.parseInbound(req);
        if (!inbound) return { status: 400 as const };
        const match = classifySmsReply(inbound.body);
        let reply: string | null = null;
        if (match?.intent === 'stop') {
          const { hash, profileIds } = await profilesWithPhone(tx, target.ws, deps.kp, inbound.from);
          const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
          const smsMarketing = purposes.filter((p) => isMarketing(p.basis) && p.channels.includes('sms'));
          for (const profileId of profileIds)
            await recordConsent(
              tx,
              target.ws,
              profileId,
              purposes,
              smsMarketing.map((p) => ({
                purpose: p.key,
                channel: 'sms',
                status: p.basis === 'legitimate_interest' ? ('objected' as const) : ('withdrawn' as const),
                source: 'unsubscribe' as const,
                proof: { via: `SMS ${match.keyword}`, provider: provider.id },
              })),
            );
          await tx
            .insert(schema.suppressions)
            .values({ workspaceId: target.ws, channel: 'sms', valueHash: hash, reason: 'stop' })
            .onConflictDoNothing();
          logger.info({ workspace: target.ws, profiles: profileIds.length }, 'SMS STOP recorded');
        } else if (match?.intent === 'start') {
          // Lifts the block only; marketing texts need a new consent. Only the SMS stop row for
          // this number is removed: a hard bounce or complaint for the same number is a delivery
          // fact, not an opt-out, and stays suppressed (#664).
          const { hash } = await profilesWithPhone(tx, target.ws, deps.kp, inbound.from);
          const lifted = await tx
            .delete(schema.suppressions)
            .where(
              and(eq(schema.suppressions.channel, 'sms'), eq(schema.suppressions.valueHash, hash), eq(schema.suppressions.reason, 'stop')),
            )
            .returning({ reason: schema.suppressions.reason });
          logger.info({ workspace: target.ws, lifted: lifted.length }, 'SMS START lifted the stop suppression');
        } else if (match?.intent === 'help') reply = billingOf(provider).helpText;
        return { status: 200 as const, reply: transport.reply(reply) };
      });
      if (result.status !== 200) return c.json({ error: result.status === 401 ? 'bad_signature' : 'not_found' }, result.status);
      if ('events' in result) {
        await deps.events.insertMessageEvents(result.events ?? []);
        return c.json({ ok: true });
      }
      return c.body(result.reply!.body, 200, { 'content-type': result.reply!.contentType });
    },
  );

  return app;
}
