import { Hono } from 'hono';
import { rejectUnsafeRawPath } from './raw-path';

// A listener for the public edge: a tunnel can point here without any path rule, so the admin UI,
// REST commands and MCP are unreachable whatever the proxy forwards.
const PUBLIC_ROOTS = new Set(['f', 'u', 'c', 'hooks']);
const PUBLIC_EXACT = new Set(['/healthz', '/readyz']);

export function publicOnly(app: Hono) {
  const pub = new Hono();
  pub.use('*', rejectUnsafeRawPath);
  pub.all('*', (c) => {
    const path = c.req.path;
    const root = path.split('/')[1] ?? '';
    if (PUBLIC_EXACT.has(path) || PUBLIC_ROOTS.has(root)) return app.fetch(c.req.raw, c.env);
    return c.json({ error: 'not_found', message: 'Not found.' }, 404);
  });
  return pub;
}
