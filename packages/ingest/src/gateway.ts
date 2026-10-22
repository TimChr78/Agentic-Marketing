import { publishedSingleton } from '@agentic-marketing/artifacts';
import { newUuid } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { type EventBus, InboundEvent } from '@agentic-marketing/events';
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

interface CachedSource extends SourceInfo {
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

function writeKeyOf(c: Context, body: Record<string, unknown>): string | undefined {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Basic ')) return Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const first = Array.isArray(body.batch) ? (body.batch[0] as Record<string, unknown> | undefined) : undefined;
  return (body.writeKey as string | undefined) ?? (first?.writeKey as string | undefined) ?? c.req.header('x-write-key');
}

export interface IngestDeps {
  db: Db;
  bus: EventBus;
  /** Events per second per source; bursts up to 5×. */
  ratePerSource?: number;
}

export function ingestApi(deps: IngestDeps) {
  const sources = ttlCache<CachedSource | null>(CACHE_MS);
  const policies = ttlCache<WorkspacePolicy>(CACHE_MS);
  const allow = rateLimiter(deps.ratePerSource ?? 1000, (deps.ratePerSource ?? 1000) * 5);

  const loadSource = (key: string) =>
    sources(keyHash(key), async () => {
      const { rows } = await deps.db.admin.query(
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
      deps.db.withWorkspace(workspaceId, async (tx) => ({
        plan: await publishedSingleton(tx, 'tracking_plan'),
        purposes: (await publishedSingleton(tx, 'purposes'))?.purposes ?? defaultPolicy.purposes,
      })),
    );

  const app = new Hono();

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
    if (!allow(source.id, items.length)) return fail(429, 'rate_limited', 'Too many events for this source; retry with backoff.');

    const receivedAt = new Date();
    const policy = await loadPolicy(source.workspaceId);
    const batchContext = (body.context as Record<string, unknown> | undefined) ?? {};
    const ip = source.kind === 'browser' ? (c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? undefined) : undefined;
    const accepted = [];
    const rejected: { index: number; error: string }[] = [];
    const warnings: { index: number; warning: string }[] = [];
    let dropped = 0;
    for (const [index, item] of items.entries()) {
      if (JSON.stringify(item).length > MAX_EVENT) {
        rejected.push({ index, error: `Events are limited to ${MAX_EVENT / 1024} KB.` });
        continue;
      }
      const withContext = item && typeof item === 'object' ? { ...item, context: { ...batchContext, ...(item.context ?? {}) } } : item;
      const parsed = InboundEvent.safeParse(withContext);
      if (!parsed.success) {
        rejected.push({ index, error: z.prettifyError(parsed.error) });
        continue;
      }
      const out = processEvent(parsed.data, source, policy, receivedAt, { ip, messageId: newUuid });
      if (out.kind === 'accepted') {
        accepted.push(out.event);
        for (const w of out.warnings) warnings.push({ index, warning: w });
      } else if (out.kind === 'dropped') dropped++;
      else rejected.push({ index, error: out.error });
    }

    if (!accepted.length && rejected.length) return c.json({ success: false, error: 'invalid_events', rejected }, 400, cors);
    const { duplicates } = accepted.length ? await deps.bus.publish(accepted) : { duplicates: 0 };
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
