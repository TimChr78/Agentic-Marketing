import { timingSafeEqual } from 'node:crypto';
import type { Db } from '@agentic-marketing/db';
import type { Handler } from 'hono';
import { collectDependencies, collectGauges, type MetricsRegistry } from '../metrics';

// `GET /metrics` (#147): a Prometheus text exposition on the main listener only. The public-only
// listener does not serve it (see public-only.ts), and without METRICS_TOKEN the route answers 404
// like any unknown path, so a default install exposes nothing new.

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsRouteDeps {
  /** When undefined the endpoint is disabled: it answers 404, not 401, so it does not advertise itself. */
  token?: string;
  registry: MetricsRegistry;
  db: Db;
  events: { ping(): Promise<boolean> };
  hot: { ping(): Promise<boolean> };
  natsUrl: string;
}

/** Constant-time bearer comparison, so a wrong token cannot be guessed by timing. */
function authorized(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function metricsHandler(deps: MetricsRouteDeps): Handler {
  return async (c) => {
    const token = deps.token;
    if (!token) return c.json({ error: 'not_found', message: 'Not found.' }, 404);
    if (!authorized(c.req.header('authorization'), token))
      return c.json({ error: 'unauthorized', message: 'The metrics token is missing or wrong.' }, 401, {
        'www-authenticate': 'Bearer realm="metrics"',
      });
    // Collected per scrape: a gauge is only useful if it is current, and both collectors time out
    // on their own so a broken dependency cannot hold the scrape open.
    const [gauges, dependencies] = await Promise.all([
      collectGauges(deps.db),
      collectDependencies({ db: deps.db, events: deps.events, hot: deps.hot, natsUrl: deps.natsUrl }),
    ]);
    return c.body(deps.registry.render({ ...gauges, dependencies }), 200, {
      'content-type': METRICS_CONTENT_TYPE,
      'cache-control': 'no-store',
    });
  };
}
