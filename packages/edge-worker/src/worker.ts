import {
  consentFrom,
  type Decision,
  decideAll,
  type EdgeSource,
  originOk,
  purposeOk,
  writeKeyHash,
} from '@agentic-marketing/personalize/core';
import { type DecideContext, deviceOf } from '@agentic-marketing/personalize/targeting';

// The decision API at the edge: the same POST /v1/decide contract as the server, answered by a
// Cloudflare Worker from Workers KV, which the scheduler keeps in sync (edge.configure). Deploy
// it on your site's domain (e.g. a route for example.com/am/v1/decide) and point the SDK's
// decideUrl at it; everything else (events, forms, e-mail links) stays on the server.
//
// What the edge cannot see: this visit's session (page views, events so far). Session and
// new-visitor conditions read as "no session"; experiences that need them belong on the server.

export const PERSONALIZATION_PURPOSE = 'web_personalization';

/** The part of a Workers KV binding the worker uses. */
export interface KvNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
}

export interface Env {
  AM_KV: KvNamespace;
  /** Seconds a worker isolate keeps experiences and write keys before reading KV again (default 10). */
  AM_CACHE_SECONDS?: string;
}

interface Bundle {
  experiences: Parameters<typeof decideAll>[0];
  purposes: { key: string; basis: string }[];
}

interface Snapshot {
  profileId: string;
  traits: Record<string, unknown>;
  segments: string[];
  at: string;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(env: Env, key: string): Promise<T | null> {
  const ttl = Number(env.AM_CACHE_SECONDS ?? 10) * 1000;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T | null>;
  const value = env.AM_KV.get(key, 'json');
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value as Promise<T | null>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

function keyOf(req: Request, body: Record<string, unknown>) {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) return atob(auth.slice(6)).split(':')[0];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return (body.writeKey as string | undefined) ?? req.headers.get('x-write-key') ?? undefined;
}

export async function decide(req: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const origin = req.headers.get('origin') ?? undefined;
  const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors, ...headers } });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
  }
  const key = keyOf(req, body);
  const source = key ? await cached<EdgeSource>(env, `am:key:${writeKeyHash(key)}`) : null;
  if (!source?.enabled) return json({ error: 'invalid_write_key', message: 'Unknown or disabled write key.' }, 401);
  if (!originOk(source, origin)) return json({ error: 'origin_not_allowed', message: `Origin ${origin ?? '(none)'} is not allowed.` }, 403);

  const placements = Array.isArray(body.placements) ? body.placements.filter((p): p is string => !!str(p, 64)) : [];
  if (!placements.length || placements.length > 20 || placements.length !== (body.placements as unknown[]).length)
    return json({ error: 'invalid_input', message: 'placements: 1 to 20 names of at most 64 characters.' }, 400);
  const anonymousId = str(body.anonymousId, 200);
  const userId = str(body.userId, 200);
  const p = (body.page ?? {}) as Record<string, unknown>;
  const page = { url: str(p.url, 2000) ?? '', path: str(p.path, 1000) ?? '/', referrer: str(p.referrer, 2000) ?? '' };
  const context = body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : undefined;
  const pv = body.preview as Record<string, unknown> | undefined;
  const preview =
    pv && str(pv.experienceId, 64) && str(pv.variantId, 32)
      ? { experienceId: pv.experienceId as string, variantId: pv.variantId as string }
      : undefined;

  const ws = source.workspaceId;
  const bundle = (await cached<Bundle>(env, `am:exp:${ws}`)) ?? { experiences: [], purposes: [] };
  const wanted = bundle.experiences.filter((e) => placements.includes(e.def.placement));
  const personalized = purposeOk(PERSONALIZATION_PURPOSE, bundle.purposes, consentFrom(context));
  // Snapshots are read only with consent and only when some experience could use them.
  let snapshot: Snapshot | null = null;
  if (personalized && wanted.length) {
    const keys = [userId && `am:snap:${ws}:u:${userId}`, anonymousId && `am:snap:${ws}:a:${anonymousId}`].filter((k): k is string => !!k);
    for (const k of keys) {
      snapshot = (await env.AM_KV.get(k, 'json').catch(() => null)) as Snapshot | null;
      if (snapshot) break;
    }
  }
  let utmSource: string | null = null;
  try {
    utmSource = page.url ? new URL(page.url).searchParams.get('utm_source') : null;
  } catch {}
  const ctx: DecideContext = {
    personalized,
    snapshot,
    session: null,
    page,
    utmSource,
    device: deviceOf((context?.userAgent as string | undefined) ?? req.headers.get('user-agent') ?? undefined),
  };
  const stableId = snapshot?.profileId ?? userId ?? anonymousId ?? '';
  const decisions: Decision[] = decideAll(wanted, placements, ctx, stableId, preview);
  return json({ decisions, personalized, edge: true }, 200, {
    'server-timing': `decide;dur=${Date.now() - started}`,
    'cache-control': 'no-store',
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.endsWith('/v1/decide')) return new Response('Not found', { status: 404 });
    if (req.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': req.headers.get('origin') ?? '*',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '86400',
          vary: 'origin',
        },
      });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    return decide(req, env);
  },
};
