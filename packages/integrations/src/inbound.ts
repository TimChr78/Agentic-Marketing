import { createHash, timingSafeEqual } from 'node:crypto';
import type { PublicRequest } from '@agentic-marketing/commands';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventBus } from '@agentic-marketing/events';
import type { ClaimOutcome, HotState } from '@agentic-marketing/hotstate';
import { acceptItems, bodyLimit, sourceLookups } from '@agentic-marketing/ingest';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { connectionSecrets, connectorOf, inboundTokenHash } from './connections';

// Inbound webhooks: POST /hooks/in/<connection>/<token>. The secret URL authenticates the
// sender, the connector verifies its signature when it has one and maps the payload to
// Segment-spec events, and they go through the same policy and bus as the ingest gateway.

// A provider callout can carry several mapped records; 1 MB covers them and is checked before
// the secret URL is authenticated or the body is read.
const MAX_BODY = 1024 * 1024;

// A pending lease is a claim whose request has not published yet. It must outlive a live request
// (the spec recommends answering webhooks within 15–30 s, and the bus waits for the JetStream
// publish ack), but not a dead one: 60 s is roughly twice that answer budget, so a crashed request
// frees its id for the sender's next retry well before its longer backoff steps.
const PENDING_TTL_S = 60;
// Standard Webhooks allows a 5-minute timestamp tolerance. Remember a finished delivery a little
// longer, so a replay inside the window is refused even when replicas' clocks disagree (#643).
const DONE_TTL_S = 10 * 60;
const RETRY_AFTER_S = 30;

/** One signed delivery's idempotency key: workspace + endpoint + signed id (#643). */
export const inboundReplayKey = (workspaceId: string, connectionId: string, webhookId: string) =>
  `inbound:${workspaceId}:${connectionId}:${webhookId}`;

export function inboundApi(deps: {
  db: Db;
  bus: EventBus;
  kp: KeyProvider;
  hot: Pick<HotState, 'claim' | 'complete' | 'release'>;
  /** Replay lease TTLs; tests shorten them. Defaults: 60 s pending, 10 min done. */
  replayTtl?: { pendingSeconds?: number; doneSeconds?: number };
}) {
  const pendingTtl = deps.replayTtl?.pendingSeconds ?? PENDING_TTL_S;
  const doneTtl = deps.replayTtl?.doneSeconds ?? DONE_TTL_S;
  const { loadPolicy } = sourceLookups(deps.db);
  const app = new Hono<{ Variables: { publicRequest?: PublicRequest } }>();
  app.post(
    '/hooks/in/:id/:token',
    // Refuse an oversized delivery before the body is read or the secret URL is authenticated.
    bodyLimit(MAX_BODY, (c) => c.json({ error: 'too_large', message: 'Webhooks are limited to 1 MB.' }, 413)),
    async (c) => {
      const { rows } = await deps.db.admin.query<{ workspace_id: string; token_hash: string | null; enabled: boolean }>(
        'SELECT workspace_id, token_hash, enabled FROM connections WHERE id = $1',
        [c.req.param('id')],
      );
      const r = rows[0];
      const given = Buffer.from(inboundTokenHash(c.req.param('token')));
      if (!r?.enabled || !r.token_hash || given.length !== r.token_hash.length || !timingSafeEqual(given, Buffer.from(r.token_hash)))
        return c.json({ error: 'not_found', message: 'Unknown or disabled webhook URL.' }, 404);
      // A connection's webhook belongs to its workspace's brand host (#185).
      const request = c.get('publicRequest');
      if (request?.workspaceId && request.workspaceId !== r.workspace_id)
        return c.json({ error: 'not_found', message: 'Unknown or disabled webhook URL.' }, 404);

      const raw = await c.req.text();
      const ws = r.workspace_id;
      const conn = await deps.db.withWorkspace(ws, async (tx) => {
        const [x] = await tx
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, c.req.param('id')));
        return x ? { row: x, secrets: await connectionSecrets(tx, x, deps.kp) } : null;
      });
      if (!conn) return c.json({ error: 'not_found', message: 'Unknown or disabled webhook URL.' }, 404);
      const connector = connectorOf(conn.row.connector);
      if (!connector.inbound) return c.json({ error: 'not_found', message: 'This connection does not receive webhooks.' }, 404);

      const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
      const ictx = {
        settings: connector.settings.parse(conn.row.settings),
        secrets: connector.secrets.parse(conn.secrets),
        headers,
        body: raw,
      };
      const problem = connector.inbound.verify(ictx);
      if (problem) {
        logger.warn({ connection: conn.row.id, problem }, 'inbound webhook refused');
        return c.json({ error: 'invalid_signature', message: `Refused: ${problem}.` }, 401);
      }
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
      let items: unknown[];
      try {
        items = await connector.inbound.map(payload, ictx);
      } catch (err) {
        return c.json({ error: 'mapping_failed', message: `The mapping failed: ${(err as Error).message}` }, 422);
      }
      const source = { id: conn.row.id, workspaceId: ws, kind: 'server' as const, requiredPurpose: null };
      const policy = await loadPolicy(ws);
      // Standard Webhooks signs the webhook-id with the body, so it is safe to use as an
      // idempotency key. Other schemes (Shopify, Salesforce) have no such header and keep their
      // own deterministic event ids.
      const webhookId = ictx.settings?.signature?.scheme === 'standard-webhooks' ? headers['webhook-id'] : undefined;
      const replayKey = webhookId ? inboundReplayKey(ws, conn.row.id, webhookId) : undefined;
      let claimToken: string | undefined;
      // A stable id per mapped record: if the hot state loses the key, JetStream still drops the
      // retried delivery because both attempts derive the same message ids (120 s window).
      const messageIdFor = webhookId
        ? (index: number) => `wh-${conn.row.id}-${createHash('sha256').update(`${ws}\n${webhookId}`).digest('hex').slice(0, 32)}-${index}`
        : undefined;
      if (replayKey) {
        let claim: ClaimOutcome;
        try {
          claim = await deps.hot.claim(replayKey, pendingTtl);
        } catch (err) {
          // Fail closed: without the shared store we cannot tell a replay from a first delivery,
          // and publishing anyway would be the duplicate the guard exists to prevent. A 5xx makes
          // the sender retry, and the retry publishes once when the store is back.
          logger.warn({ err, connection: conn.row.id }, 'inbound webhook replay check unavailable');
          return c.json({ error: 'replay_check_unavailable', message: 'Could not check this webhook for a replay. Retry shortly.' }, 503, {
            'retry-after': String(RETRY_AFTER_S),
          });
        }
        if (claim.state === 'done') {
          // The spec treats any 2xx as delivered and any other status as a failure to retry, so a
          // duplicate is a success that says nothing new was ingested (200, not 409).
          logger.warn({ connection: conn.row.id, webhookId }, 'inbound webhook already received');
          return c.json({ success: true, duplicate: true, accepted: 0, duplicates: 0, dropped: 0 });
        }
        if (claim.state === 'pending') {
          // Another request claimed this id and has not published yet. Acknowledging now would let
          // a crash between its claim and its publish look like a completed delivery; the sender
          // must retry instead. Its lease expires if that request died.
          logger.warn({ connection: conn.row.id, webhookId }, 'inbound webhook still in progress');
          return c.json({ error: 'in_progress', message: 'This webhook is already being processed. Retry shortly.' }, 503, {
            'retry-after': String(RETRY_AFTER_S),
          });
        }
        claimToken = claim.token;
      }
      const { accepted, rejected, dropped } = acceptItems(items, source, policy, messageIdFor ? { messageId: messageIdFor } : {});
      let duplicates: number;
      try {
        ({ duplicates } = accepted.length ? await deps.bus.publish(accepted) : { duplicates: 0 });
      } catch (err) {
        // Nothing was published: forgetting the pending lease lets the sender's retry through
        // instead of turning a transient bus failure into a lost delivery.
        if (replayKey && claimToken) await deps.hot.release(replayKey, claimToken).catch(() => {});
        throw err;
      }
      if (replayKey && claimToken) {
        // The delivery is only marked done after a successful publish. If the lease expired and
        // another request took over, complete() refuses (the token no longer matches): both may
        // publish, but the message ids derived from the webhook-id are identical, so JetStream
        // drops the second within its 120 s duplicate window. A takeover that publishes later
        // than that window could duplicate; a live request finishes far inside the lease.
        const done = await deps.hot.complete(replayKey, claimToken, doneTtl).catch((err) => {
          logger.warn({ err, connection: conn.row.id }, 'inbound webhook could not be marked done');
          return false;
        });
        if (!done) logger.warn({ connection: conn.row.id, webhookId }, 'inbound webhook lease expired before it was marked done');
      }
      if (rejected.length) logger.warn({ connection: conn.row.id, rejected }, 'inbound webhook events rejected');
      return c.json({ success: true, accepted: accepted.length, duplicates, dropped, ...(rejected.length ? { rejected } : {}) });
    },
  );
  // Every other /hooks path is still an API path: answer JSON, never the admin SPA (#610).
  const notFound = (c: Context) => c.json({ error: 'not_found', message: 'Not found.' }, 404);
  app.all('/hooks', notFound);
  app.all('/hooks/*', notFound);
  return app;
}
