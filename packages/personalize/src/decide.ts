import { publishListeners } from '@agentic-marketing/artifacts';
import type { Db } from '@agentic-marketing/db';
import { consentOf } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { bodyLimit, consentAllows, originAllowed, sourceLookups, writeKeyOf } from '@agentic-marketing/ingest';
import { logger } from '@agentic-marketing/telemetry';
import { Hono } from 'hono';
import { z } from 'zod';
import { decideAll, type PublishedExperience } from './core';
import { loadPublishedExperiences } from './edge';
import { type DecideContext, deviceOf } from './targeting';

// The decision API (channels-and-personalization.md §3.3): POST /v1/decide with a write key.
// Reads only hot state (Valkey) and cached experience definitions, never Postgres or ClickHouse
// on the request path, so it can answer before the page paints.

export const PERSONALIZATION_PURPOSE = 'web_personalization';
const CACHE_MS = 30_000;
// A decision request is a write key, up to 20 placement names and the page/context: far below
// 32 KB in practice, which still allows a large context object without letting it grow unbounded.
const DECIDE_MAX_BODY = 32 * 1024;

const DecideRequest = z.object({
  writeKey: z.string().optional(),
  anonymousId: z.string().min(1).max(200).optional(),
  userId: z.string().min(1).max(200).optional(),
  placements: z.array(z.string().max(64)).min(1).max(20),
  page: z
    .object({ url: z.string().max(2000).default(''), path: z.string().max(1000).default('/'), referrer: z.string().max(2000).default('') })
    .default({ url: '', path: '/', referrer: '' }),
  context: z.record(z.string(), z.unknown()).optional(),
  preview: z
    .object({ experienceId: z.string().max(64), variantId: z.string().max(32) })
    .optional()
    .describe('Show this variant of this experience (the editor’s preview link), ignoring targeting'),
});

export function decideApi(deps: { db: Db; hot: HotState }) {
  const { loadSource, loadPolicy } = sourceLookups(deps.db);
  const cache = new Map<string, { at: number; stamp: string; list: Promise<PublishedExperience[]> }>();
  // Publishing an experience bumps the workspace's stamp in Valkey; it is checked at most once a
  // second per workspace, so a change shows within about a second (CACHE_MS stays as a backstop).
  const stamps = new Map<string, { at: number; stamp: Promise<string> }>();
  const stampOf = (ws: string) => {
    const s = stamps.get(ws);
    if (s && Date.now() - s.at < 1000) return s.stamp;
    const stamp = deps.hot.stamp(`experiences:${ws}`).catch(() => '?');
    stamps.set(ws, { at: Date.now(), stamp });
    return stamp;
  };
  const experiences = async (ws: string) => {
    const stamp = await stampOf(ws);
    const hit = cache.get(ws);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.list;
    const list = deps.db.withWorkspace(ws, loadPublishedExperiences);
    cache.set(ws, { at: Date.now(), stamp, list });
    list.catch(() => cache.delete(ws));
    return list;
  };

  const app = new Hono();
  const cors = (origin: string | undefined): Record<string, string> =>
    origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};

  app.options('/v1/decide', (c) =>
    c.body(null, 204, {
      'access-control-allow-origin': c.req.header('origin') ?? '*',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      vary: 'origin',
    }),
  );

  app.post(
    '/v1/decide',
    bodyLimit(DECIDE_MAX_BODY, (c) => {
      const origin = c.req.header('origin');
      return c.json(
        { error: 'payload_too_large', message: `Requests are limited to ${DECIDE_MAX_BODY / 1024} KB.` },
        413,
        origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {},
      );
    }),
    async (c) => {
      const started = performance.now();
      const origin = c.req.header('origin');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400, cors(origin));
      }
      const key = writeKeyOf(c, body);
      const source = key ? await loadSource(key) : null;
      if (!source?.enabled) return c.json({ error: 'invalid_write_key', message: 'Unknown or disabled write key.' }, 401, cors(origin));
      if (!originAllowed(source, origin))
        return c.json({ error: 'origin_not_allowed', message: `Origin ${origin ?? '(none)'} is not allowed.` }, 403, cors(origin));
      const parsed = DecideRequest.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_input', message: z.prettifyError(parsed.error) }, 400, cors(origin));
      const req = parsed.data;
      const ws = source.workspaceId;

      const [list, policy] = await Promise.all([experiences(ws), loadPolicy(ws)]);
      const wanted = list.filter((e) => req.placements.includes(e.def.placement));
      const personalized = consentAllows({ ...source, requiredPurpose: PERSONALIZATION_PURPOSE }, policy, consentOf(req.context));
      // Hot state is read only when it may be used, and only if some experience needs it.
      const [snapshot, session] =
        personalized && wanted.length
          ? await Promise.all([
              deps.hot.snapshot(ws, { anonymousId: req.anonymousId, userId: req.userId }).catch(() => null),
              req.anonymousId ? deps.hot.session(ws, req.anonymousId).catch(() => null) : Promise.resolve(null),
            ])
          : [null, null];
      let utmSource: string | null = null;
      try {
        utmSource = req.page.url ? new URL(req.page.url).searchParams.get('utm_source') : null;
      } catch {}
      const ctx: DecideContext = {
        personalized,
        snapshot,
        session,
        page: req.page,
        utmSource,
        device: deviceOf((req.context?.userAgent as string | undefined) ?? c.req.header('user-agent')),
      };
      const stableId = snapshot?.profileId ?? req.userId ?? req.anonymousId ?? '';

      const decisions = decideAll(wanted, req.placements, ctx, stableId, req.preview);
      const ms = performance.now() - started;
      if (ms > 50) logger.warn({ ms: Math.round(ms), workspace: ws }, 'slow decision');
      return c.json({ decisions, personalized }, 200, {
        ...cors(origin),
        'server-timing': `decide;dur=${ms.toFixed(1)}`,
        'cache-control': 'no-store',
      });
    },
  );

  return app;
}

publishListeners.push(async (ctx, a) => {
  if (a.type === 'experience') await ctx.services.hot.bump(`experiences:${a.workspaceId}`);
});
