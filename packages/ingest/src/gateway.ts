import { publishedSingleton } from '@agentic-marketing/artifacts';
import { newUuid, remoteAddressFromEnv, resolveClientIp } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { type BusEvent, type EventBus, InboundEvent } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { logger } from '@agentic-marketing/telemetry';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { defaultPolicy, processEvent, type SourceInfo, type WorkspacePolicy } from './policy';
import { keyHash } from './sources';

// The ingest gateway (ingest role): the Segment HTTP Tracking API at /v1/{batch,track,page,…}
// plus the short paths analytics.js uses (/v1/b, /v1/t, …). It authenticates the source, runs
// the policy per event, publishes to the bus and answers once the bus has the events.

const MAX_BODY = 500 * 1024;
const MAX_EVENT = 32 * 1024;
const CACHE_MS = 30_000;

const paths: Record<string, InboundEvent['type'] | 'batch'> = {
  batch: 'batch',
  b: 'batch',
  track: 'track',
  t: 'track',
  page: 'page',
  p: 'page',
  screen: 'screen',
  s: 'screen',
  identify: 'identify',
  i: 'identify',
  group: 'group',
  g: 'group',
  alias: 'alias',
  a: 'alias',
};

// Crawlers, link previewers, headless browsers and HTTP tools. Their "visits" are not people, so
// browser sources drop them (answering success, so they learn nothing).
export const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|bingpreview|embedly|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp|java\/|axios\/|node-fetch|phantomjs|puppeteer|playwright/i;
export const isBot = (ua: string | undefined) => !ua || BOT_UA.test(ua);

export interface CachedSource extends SourceInfo {
  enabled: boolean;
  allowedOrigins: string[];
}

/** Small cache with expiry, so hot-path lookups hit Postgres at most once per key and 30 s. */
function ttlCache<V>(ms: number) {
  const m = new Map<string, { v: V; at: number }>();
  return async (key: string, load: () => Promise<V>) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.v;
    const v = await load();
    if (m.size > 10_000) m.clear();
    m.set(key, { v, at: Date.now() });
    return v;
  };
}

/** Token bucket per source: sustained `rate` events/s with bursts up to `burst`. */
function rateLimiter(rate: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string, n: number) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  };
}

export function writeKeyOf(c: Context, body: Record<string, unknown>): string | undefined {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Basic ')) return Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const first = Array.isArray(body.batch) ? (body.batch[0] as Record<string, unknown> | undefined) : undefined;
  return (body.writeKey as string | undefined) ?? (first?.writeKey as string | undefined) ?? c.req.header('x-write-key');
}

/** Validates and applies the workspace policy to raw Segment-spec events (shared by the gateway and inbound webhooks). */
export function acceptItems(
  items: unknown[],
  source: SourceInfo,
  policy: WorkspacePolicy,
  opts: { ip?: string; context?: Record<string, unknown>; receivedAt?: Date } = {},
) {
  const receivedAt = opts.receivedAt ?? new Date();
  const accepted: BusEvent[] = [];
  const rejected: { index: number; error: string }[] = [];
  const warnings: { index: number; warning: string }[] = [];
  let dropped = 0;
  for (const [index, item] of items.entries()) {
    if (JSON.stringify(item).length > MAX_EVENT) {
      rejected.push({ index, error: `Events are limited to ${MAX_EVENT / 1024} KB.` });
      continue;
    }
    const withContext =
      item && typeof item === 'object'
        ? { ...item, context: { ...opts.context, ...((item as { context?: Record<string, unknown> }).context ?? {}) } }
        : item;
    const parsed = InboundEvent.safeParse(withContext);
    if (!parsed.success) {
      rejected.push({ index, error: z.prettifyError(parsed.error) });
      continue;
    }
    const out = processEvent(parsed.data, source, policy, receivedAt, { ip: opts.ip, messageId: newUuid });
    if (out.kind === 'accepted') {
      accepted.push(out.event);
      for (const w of out.warnings) warnings.push({ index, warning: w });
    } else if (out.kind === 'dropped') dropped++;
    else rejected.push({ index, error: out.error });
  }
  return { accepted, rejected, warnings, dropped };
}

export interface IngestDeps {
  db: Db;
  bus: EventBus;
  /** Session state for the decision API, written before the request is answered. */
  hot?: HotState;
  /** Headers with the client IP, in trust order (e.g. cf-connecting-ip, x-forwarded-for). */
  clientIpHeaders?: string[];
  /** When set, forwarding headers are trusted only from these proxy/loopback ranges. */
  trustedProxyCidrs?: string[];
  /** @deprecated Use `clientIpHeaders`; kept for backwards compatibility. */
  clientIpHeader?: string;
  /** Events per second per source; bursts up to 5×. */
  ratePerSource?: number;
}

/** Write key → source, and workspace → policy, each cached for 30 s (shared with the decision API). */
export function sourceLookups(db: Db) {
  const sources = ttlCache<CachedSource | null>(CACHE_MS);
  const policies = ttlCache<WorkspacePolicy>(CACHE_MS);
  const loadSource = (key: string) =>
    sources(keyHash(key), async () => {
      const { rows } = await db.admin.query(
        'SELECT id, workspace_id, kind, required_purpose, enabled, allowed_origins FROM sources WHERE key_hash = $1',
        [keyHash(key)],
      );
      const r = rows[0];
      return r
        ? {
            id: r.id,
            workspaceId: r.workspace_id,
            kind: r.kind,
            requiredPurpose: r.required_purpose,
            enabled: r.enabled,
            allowedOrigins: r.allowed_origins,
          }
        : null;
    });
  const loadPolicy = (workspaceId: string) =>
    policies(workspaceId, () =>
      db.withWorkspace(workspaceId, async (tx) => ({
        plan: await publishedSingleton(tx, 'tracking_plan'),
        purposes: (await publishedSingleton(tx, 'purposes'))?.purposes ?? defaultPolicy.purposes,
      })),
    );
  return { loadSource, loadPolicy };
}

/** Whether a browser request may use this source (allowed origins); server sources have no origin rule. */
export function originAllowed(source: CachedSource, origin: string | undefined) {
  return (
    source.kind !== 'browser' || source.allowedOrigins.includes('*') || (!!origin && source.allowedOrigins.includes(origin.toLowerCase()))
  );
}

export function ingestApi(deps: IngestDeps) {
  const { loadSource, loadPolicy } = sourceLookups(deps.db);
  const allow = rateLimiter(deps.ratePerSource ?? 1000, (deps.ratePerSource ?? 1000) * 5);
  const headerNames = deps.clientIpHeaders ?? (deps.clientIpHeader ? [deps.clientIpHeader] : ['x-forwarded-for']);

  const app = new Hono();

  // The consent banner's texts: the workspace's purposes for the web, by write key.
  app.get('/v1/consent/purposes', async (c) => {
    const origin = c.req.header('origin');
    const key = c.req.query('writeKey') ?? writeKeyOf(c, {});
    const source = key ? await loadSource(key) : null;
    if (!source?.enabled) return c.json({ error: 'invalid_write_key' }, 401);
    if (!originAllowed(source, origin)) return c.json({ error: 'origin_not_allowed' }, 403);
    const { purposes } = await loadPolicy(source.workspaceId);
    return c.json(
      {
        purposes: purposes
          .filter((p) => p.channels.includes('web'))
          .map((p) => ({ key: p.key, name: p.name, description: p.description, basis: p.basis })),
      },
      200,
      { ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}), 'cache-control': 'public, max-age=300' },
    );
  });

  // Browsers preflight cross-origin JSON posts. The origin is checked on the real request, once
  // the write key says which origins are allowed.
  app.options('/v1/:kind{[a-z]+}', (c) => {
    if (!paths[c.req.param('kind')]) return c.notFound();
    return c.body(null, 204, {
      'access-control-allow-origin': c.req.header('origin') ?? '*',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      vary: 'origin',
    });
  });

  app.post('/v1/:kind{[a-z]+}', async (c) => {
    const kind = paths[c.req.param('kind')];
    if (!kind) return c.notFound();
    const origin = c.req.header('origin');
    const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    const fail = (status: 400 | 401 | 403 | 413 | 429, error: string, message: string) =>
      c.json({ success: false, error, message }, status, cors);

    // sendBeacon posts text/plain, so parse the body ourselves whatever the content type says.
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return fail(413, 'too_large', `Requests are limited to ${MAX_BODY / 1024} KB; send smaller batches.`);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, 'invalid_json', 'The body is not JSON.');
    }

    const key = writeKeyOf(c, body);
    const source = key ? await loadSource(key) : null;
    if (!source?.enabled) return fail(401, 'invalid_write_key', 'Unknown or disabled write key.');
    if (
      source.kind === 'browser' &&
      !source.allowedOrigins.includes('*') &&
      !(origin && source.allowedOrigins.includes(origin.toLowerCase()))
    )
      return fail(403, 'origin_not_allowed', `Origin ${origin ?? '(none)'} is not allowed for this source.`);

    const items = kind === 'batch' ? (Array.isArray(body.batch) ? body.batch : null) : [{ ...body, type: kind }];
    if (!items?.length) return fail(400, 'invalid_batch', 'A batch needs a non-empty "batch" array.');
    const rate = deps.ratePerSource ?? 1000;
    const ok = deps.hot
      ? await deps.hot.take(`src:${source.id}`, items.length, rate, rate * 5).catch(() => allow(source.id, items.length))
      : allow(source.id, items.length);
    if (!ok) return fail(429, 'rate_limited', 'Too many events for this source; retry with backoff.');

    if (source.kind === 'browser' && isBot(c.req.header('user-agent')))
      return c.json({ success: true, accepted: 0, duplicates: 0, dropped: items.length }, 200, cors);
    const policy = await loadPolicy(source.workspaceId);
    const ip =
      source.kind === 'browser'
        ? resolveClientIp({
            header: (name) => c.req.header(name),
            remoteAddress: remoteAddressFromEnv(c.env),
            headerNames,
            trustedProxyCidrs: deps.trustedProxyCidrs,
          })
        : undefined;
    const { accepted, rejected, warnings, dropped } = acceptItems(items, source, policy, {
      ip,
      context: (body.context as Record<string, unknown> | undefined) ?? {},
    });

    if (!accepted.length && rejected.length) return c.json({ success: false, error: 'invalid_events', rejected }, 400, cors);
    const { duplicates } = accepted.length ? await deps.bus.publish(accepted) : { duplicates: 0 };
    // Session state is best effort: the events are safely on the bus already.
    if (accepted.length && deps.hot)
      await deps.hot.recordSessions(accepted).catch((err) => logger.warn({ err }, 'session state not updated'));
    if (rejected.length) logger.warn({ source: source.id, rejected: rejected.length }, 'ingest rejected events');
    return c.json(
      {
        success: true,
        accepted: accepted.length,
        duplicates,
        dropped,
        ...(rejected.length ? { rejected } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
      200,
      cors,
    );
  });

  return app;
}
