import type { Context, Next } from 'hono';

// A proxy (e.g. cloudflared) matches its path rule against the raw request target and forwards it
// raw, while the app's URL parser resolves dot-segments. Check the raw target before routing so a
// rule that lets `/f/...` through cannot be turned into `/v1/...`, `/api/auth/...` or `/mcp`.

const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

/**
 * True when the raw request target's path can resolve to something other than what a proxy saw.
 * Dot segments (`/f/../v1/x`), encoded dots or slashes (`%2e`, `%2f`, `%5c`) and backslashes are
 * rejected; the query is not inspected, so tokens and tracking parameters may contain them.
 */
export function unsafeRawPath(raw: string): boolean {
  const path = raw.split('?', 1)[0] ?? '';
  if (path.includes('\\')) return true;
  if (ENCODED_SEPARATOR.test(path)) return true;
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/** Rejects a request whose raw target is unsafe. @hono/node-server exposes it as `env.incoming`. */
export async function rejectUnsafeRawPath(c: Context, next: Next) {
  const raw = (c.env as { incoming?: { url?: string } } | undefined)?.incoming?.url;
  if (raw && unsafeRawPath(raw)) {
    return c.json({ error: 'bad_request', message: 'The request path is not allowed.' }, 400);
  }
  await next();
}
