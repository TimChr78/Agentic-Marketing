import { DEFAULT_PURPOSES, type Purposes, publishedSingleton } from '@agentic-marketing/artifacts';
import type { PublicRequest } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { bodyLimit } from '@agentic-marketing/ingest';
import { IdentityLockTimeoutError, personCrypto, recordConsentEvidence, withIdentityLock } from '@agentic-marketing/profiles';
import { type KeyProvider, type PreparedKeys, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { applyDeliveryEvents, logSuppressionEscalation } from '../deliveryEvents';
import type { EmailServices } from '../gateway';
import { enqueueMessageEvents } from '../outbox';
import { isMarketing } from '../policy';
import { PUBLIC_IDENTITY_LOCK_RETRY_AFTER_SECONDS, PUBLIC_IDENTITY_LOCK_WAIT_MS } from '../publicLock';
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
  email: EmailServices;
  /** How long a public callback waits for the identity lock before a retryable 503 (#1074). */
  identityLockWaitMs?: number;
  identityLockRetryAfterSeconds?: string;
}

async function profilesWithPhone(tx: Tx, ws: string, prepared: PreparedKeys, phone: string) {
  const hash = await personCrypto(tx, ws, prepared.provider).matchHash('phone', phone);
  const rows = await tx
    .select({ profileId: schema.identifiers.profileId })
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.type, 'phone'), eq(schema.identifiers.value, hash)));
  return { hash, profileIds: rows.map((r) => r.profileId) };
}

export interface SmsOptOutInput {
  workspaceId: string;
  providerId: string;
  /** The matched keyword in its canonical spelling. */
  keyword: string;
  /** Whether the keyword is a STOP (withdraw and suppress) or a START (lift the stop only). */
  intent: 'stop' | 'start';
  phone: string;
  /** The person's action time: this is a synchronous write, never when a job got to it (#928). */
  receivedAt: Date;
  /** The matching key, unwrapped before the transaction; no provider call runs under the lock. */
  prepared: PreparedKeys;
  /** How long this public callback may wait for the identity lock; omitted waits without a bound. */
  lockWaitMs?: number;
}

export interface SmsOptOutResult {
  profileIds: string[];
  /** The number of STOP rows a START lifted. Always 0 for a STOP. */
  lifted: number;
}

/**
 * Applies a STOP or START keyword. The caller has prepared the transport already; the identity lock
 * is taken here, before the phone hash is resolved, so a STOP records against the survivor of a
 * merge and a START cannot lift a suppression for a person who was just merged away.
 *
 * A START only lifts a `stop` row. A hard bounce or complaint for the same number is a delivery
 * fact, not an opt-out (#664, #750), and neither keyword grants consent: marketing texts still need
 * a new, separate consent.
 */
export async function applySmsOptOut(tx: Tx, input: SmsOptOutInput): Promise<SmsOptOutResult> {
  const { workspaceId } = input;
  return withIdentityLock(
    tx,
    workspaceId,
    async () => {
      const purposes: Purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      if (input.intent === 'stop') {
        const { hash, profileIds } = await profilesWithPhone(tx, workspaceId, input.prepared, input.phone);
        const smsMarketing = purposes.filter((p) => isMarketing(p.basis) && p.channels.includes('sms'));
        for (const profileId of profileIds)
          await recordConsentEvidence(
            tx,
            workspaceId,
            profileId,
            purposes,
            smsMarketing.map((p) => ({
              purpose: p.key,
              channel: 'sms',
              status: p.basis === 'legitimate_interest' ? ('objected' as const) : ('withdrawn' as const),
              source: 'unsubscribe' as const,
              recordedAt: input.receivedAt,
              proof: { via: `SMS ${input.keyword}`, provider: input.providerId },
            })),
          );
        // A STOP is the weakest suppression reason: DO NOTHING leaves a hard_bounce or complaint
        // row in place, so a later START (which deletes only 'stop') cannot unsuppress it (#664,
        // #750).
        await tx.insert(schema.suppressions).values({ workspaceId, channel: 'sms', valueHash: hash, reason: 'stop' }).onConflictDoNothing();
        logger.info({ workspace: workspaceId, profiles: profileIds.length }, 'SMS STOP recorded');
        return { profileIds, lifted: 0 };
      }

      // Only the SMS stop row for this number is removed: a hard bounce or complaint is kept.
      const { hash, profileIds } = await profilesWithPhone(tx, workspaceId, input.prepared, input.phone);
      const lifted = await tx
        .delete(schema.suppressions)
        .where(and(eq(schema.suppressions.channel, 'sms'), eq(schema.suppressions.valueHash, hash), eq(schema.suppressions.reason, 'stop')))
        .returning({ reason: schema.suppressions.reason });
      logger.info({ workspace: workspaceId, lifted: lifted.length }, 'SMS START lifted the stop suppression');
      return { profileIds, lifted: lifted.length };
    },
    { waitMs: input.lockWaitMs },
  );
}

export function smsRoutes(deps: Deps) {
  const app = new Hono<{ Variables: { publicRequest?: PublicRequest } }>();
  const lockWaitMs = deps.identityLockWaitMs ?? PUBLIC_IDENTITY_LOCK_WAIT_MS;
  const lockRetryAfter = deps.identityLockRetryAfterSeconds ?? PUBLIC_IDENTITY_LOCK_RETRY_AFTER_SECONDS;

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
      // The provider's payload carries no message time, so the request's arrival is the action's
      // time. It is fixed once, before any retry: a re-prepared transaction must record the same
      // instant, never the time a retry happened (#928).
      const receivedAt = kind === 'inbound' ? new Date() : null;
      const write = (prepared: PreparedKeys | null) =>
        deps.db.withWorkspace(target.ws, async (tx) => {
          const [provider] = await tx.select().from(schema.smsProviders).where(eq(schema.smsProviders.id, target.id));
          if (!provider) return { status: 404 as const };
          const transport = await smsTransportFor(tx, provider, deps.kp, deps.email.adapterDeps);
          if (!transport.verifyWebhook(req)) return { status: 401 as const };

          if (kind === 'status') {
            const applied = await applyDeliveryEvents(tx, transport.parseStatus(req), provider.adapter, { waitMs: lockWaitMs });
            await enqueueMessageEvents(tx, target.ws, applied.events);
            return { status: 200 as const, events: applied.events, escalations: applied.escalations };
          }

          const inbound = transport.parseInbound(req);
          if (!inbound) return { status: 400 as const };
          const match = classifySmsReply(inbound.body);
          let reply: string | null = null;
          if (match?.intent === 'stop' || match?.intent === 'start') {
            await applySmsOptOut(tx, {
              workspaceId: target.ws,
              providerId: provider.id,
              keyword: match.keyword,
              intent: match.intent,
              phone: inbound.from,
              receivedAt: receivedAt!,
              prepared: prepared!,
              lockWaitMs,
            });
          } else if (match?.intent === 'help') reply = billingOf(provider).helpText;
          return { status: 200 as const, reply: transport.reply(reply) };
        });
      // The matching key is unwrapped before the write transaction, and the whole prepare-and-write
      // pair is retried when a key changed in between: the STOP/START block holds the identity lock
      // and must never reach the key provider (#978 part 3). A `status` callback needs no key, so
      // it runs once.
      let result: Awaited<ReturnType<typeof write>>;
      try {
        result =
          kind === 'inbound'
            ? await withPreparedKeys(
                () => prepareKeys(deps.db, target.ws, deps.kp, { purposes: ['matching'] }),
                (prepared) => write(prepared),
              )
            : await write(null);
      } catch (err) {
        // A long merge or import held the lock past the public bound: the provider retries on 503.
        if (err instanceof IdentityLockTimeoutError)
          return c.text('The request could not be handled right now. Please try again shortly.', 503, { 'retry-after': lockRetryAfter });
        throw err;
      }
      if (result.status !== 200) return c.json({ error: result.status === 401 ? 'bad_signature' : 'not_found' }, result.status);
      if ('events' in result) {
        // After the transaction committed: a rolled-back escalation leaves no log behind.
        for (const escalation of result.escalations ?? []) logSuppressionEscalation(escalation);
        return c.json({ ok: true });
      }
      return c.body(result.reply!.body, 200, { 'content-type': result.reply!.contentType });
    },
  );

  return app;
}
