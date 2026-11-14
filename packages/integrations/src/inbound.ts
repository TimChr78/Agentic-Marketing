import { createHash, timingSafeEqual } from 'node:crypto';
import type { PublicRequest } from '@agentic-marketing/commands';
import { safeErrorText } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventBus } from '@agentic-marketing/events';
import type { ClaimOutcome, HotState } from '@agentic-marketing/hotstate';
import { acceptInternalItems, bodyLimit, sourceLookups } from '@agentic-marketing/ingest';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import jsonata from 'jsonata';
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

/** What a mapping read from the request headers while it ran (0.14.11 review round 7). */
export interface HeaderReads {
  /** Header names read individually (only names the request carries). */
  names: Set<string>;
  /** The headers object was enumerated or copied, so any header may have been read. */
  all: boolean;
}

/**
 * The request headers behind a proxy that records which of them a mapping reads. Reading a header
 * (any property access, `in`, a descriptor) records its name; enumerating the object (`*`, `**`,
 * `$keys`, `$each`, `$spread`, `$string()`, `$eval`, copying it into the output) records "all".
 * Analysing the mapping's source cannot follow every JSONata construct; watching the evaluation can.
 * Names the request does not carry are not recorded (JSONata probes internal properties), but a
 * delivery that does carry a read header records it, so the identity still changes.
 */
export function trackHeaderReads(headers: Record<string, string>): { proxy: Record<string, string>; reads: HeaderReads } {
  const reads: HeaderReads = { names: new Set(), all: false };
  const note = (key: string | symbol) => {
    if (typeof key === 'string' && Object.hasOwn(headers, key)) reads.names.add(key);
  };
  const proxy = new Proxy(headers, {
    get(target, key, receiver) {
      note(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      note(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      note(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      reads.all = true;
      return Reflect.ownKeys(target);
    },
  });
  return { proxy, reads };
}

/**
 * A delivery's replay identity from its headers (0.14.11 review round 10): the values of the headers
 * the mapping read in its real run (every header if it enumerated or copied the object). A
 * connector that declares its identity headers (Shopify's topic) uses exactly those instead.
 *
 * - No header-caused difference is folded away: two identities match only when both runs read the
 *   same headers with the same values, and a header that made two outputs differ was read by at
 *   least one of those runs. Differences caused only by the clock or randomness dedupe as replays.
 * - A header the mapping never reads cannot make a replay look new: neither an extra header added
 *   to a signed body nor, when the mapping does not read them, a provider's per-attempt signature,
 *   timestamp or forwarding header.
 * - A mapping that enumerates or copies the whole object (`*`, `**`, `$spread`, `$string(headers)`,
 *   embedding `headers`) reads every header, so the per-attempt values a proxy or sender changes
 *   on each retry (`date`, `cf-ray`, `x-request-id`, signatures) enter the identity too. Such a
 *   mapping does not dedupe retries behind a proxy and may publish once per retry; it never loses
 *   an event.
 * - Accepted residual: a mapping whose choice of which headers to read depends on the clock or on
 *   randomness can give an identical retry another identity, so it may publish twice; it never
 *   loses an event. Standard Webhooks avoids both residuals: its signed `webhook-id` is the replay
 *   key.
 */
export function headerIdentity(headers: Record<string, string>, reads: HeaderReads, connectorHeaders?: readonly string[]): string {
  const keys = connectorHeaders ? connectorHeaders.map((h) => h.toLowerCase()) : reads.all ? Object.keys(headers) : [...reads.names];
  return [...new Set(keys)]
    .sort()
    .map((k) => `${k}:${headers[k] ?? ''}`)
    .join('\n');
}

/**
 * The header identity a generic JSONata mapping gives one request, evaluated the way the generic
 * connector maps it (one real run, output copied). Used by tests.
 */
export async function mappedReplayHeaders(mapping: string, body: unknown, headers: Record<string, string>): Promise<string> {
  const { proxy, reads } = trackHeaderReads(headers);
  const v = await jsonata(mapping).evaluate({ body, headers: proxy });
  if (v !== undefined) JSON.stringify(v);
  return headerIdentity(headers, reads);
}

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
      const tracked = trackHeaderReads(headers);
      let items: unknown[];
      try {
        // The mapping runs against a proxy that records which headers it reads (round 7).
        items = await connector.inbound.map(payload, { ...ictx, headers: tracked.proxy });
      } catch (err) {
        // The mapping is the workspace's own JSONata, so its message is useful; redact it all the same
        // before it leaves in an HTTP response (#885).
        return c.json({ error: 'mapping_failed', message: `The mapping failed: ${safeErrorText((err as Error).message, 500)}` }, 422);
      }
      // A connector's mapping is platform-defined (Shopify orders, Salesforce records, a generic
      // JSONata mapping): a strict tracking plan must not drop those events while the sender is
      // told the delivery succeeded (#764). `acceptInternalItems` is the trusted path, so a public
      // `/v1` client still cannot claim the exemption.
      const source = { id: conn.row.id, workspaceId: ws, kind: 'server' as const, requiredPurpose: null, platform: true };
      const policy = await loadPolicy(ws);
      // Standard Webhooks signs the webhook-id with the body, so the header is a sender-chosen
      // idempotency key. Every other scheme has no id that changes with the body: hmac-sha256 has
      // no timestamp or nonce (signing.ts verifyHmac) and an unsigned secret URL has nothing at
      // all. There the raw body is the only stable identity a replay has, so derive the key from
      // it; the hot-state done TTL is the dedupe window, since those schemes carry no timestamp.
      const scheme = ictx.settings?.signature?.scheme;
      const webhookId = scheme === 'standard-webhooks' ? headers['webhook-id'] : undefined;
      // The replay identity comes from the **request**, never from the mapping's output: a mapping
      // can read a header (`x-event-id`, a device id, a timestamp) into any field, so two deliveries
      // with one body can be two events; and it can call $millis() or $uuid(), so its output differs
      // on every replay. The key is the connection, the raw body and the values of the headers the
      // mapping or the connector reads (0.14.11 review, rounds 1 to 3).
      // A connector that declares its identity headers (Shopify's topic) uses exactly those; any other
      // uses the headers its mapping actually read.
      // Identity from the headers the real run read (round 10).
      const replayHeaders = headerIdentity(headers, tracked.reads, connector.inbound.replayHeaders);
      const replayId =
        webhookId ??
        (scheme === 'standard-webhooks'
          ? undefined
          : createHash('sha256').update(`${conn.row.id}\n${raw}\n${replayHeaders}`).digest('hex'));
      const replayKey = replayId ? inboundReplayKey(ws, conn.row.id, replayId) : undefined;
      let claimToken: string | undefined;
      // A stable id per mapped record: if the hot state loses the key, JetStream still drops the
      // retried delivery because both attempts derive the same message ids (120 s window).
      const messageIdFor = replayId
        ? (index: number) => `wh-${conn.row.id}-${createHash('sha256').update(`${ws}\n${replayId}`).digest('hex').slice(0, 32)}-${index}`
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
          logger.warn({ connection: conn.row.id, replayId }, 'inbound webhook already received');
          return c.json({ success: true, duplicate: true, accepted: 0, duplicates: 0, dropped: 0 });
        }
        if (claim.state === 'pending') {
          // Another request claimed this id and has not published yet. Acknowledging now would let
          // a crash between its claim and its publish look like a completed delivery; the sender
          // must retry instead. Its lease expires if that request died.
          logger.warn({ connection: conn.row.id, replayId }, 'inbound webhook still in progress');
          return c.json({ error: 'in_progress', message: 'This webhook is already being processed. Retry shortly.' }, 503, {
            'retry-after': String(RETRY_AFTER_S),
          });
        }
        claimToken = claim.token;
      }
      const { accepted, rejected, dropped } = acceptInternalItems(items, source, policy, messageIdFor ? { messageId: messageIdFor } : {});
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
        if (!done) logger.warn({ connection: conn.row.id, replayId }, 'inbound webhook lease expired before it was marked done');
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
