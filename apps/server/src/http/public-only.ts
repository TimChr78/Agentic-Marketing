import { Hono } from 'hono';
import { rejectUnsafeRawPath } from './raw-path';

// A listener for the public edge: a tunnel can point here without any path rule, so the admin UI,
// REST commands and MCP are unreachable whatever the proxy forwards.
const PUBLIC_ROOTS = new Set(['f', 'u', 'c', 'a', 'n', 'hooks']);
const PUBLIC_EXACT = new Set(['/healthz', '/readyz']);

/** The per-domain verification challenge (#185): <prefix>/.well-known/am-domain/<token>. */
export const DOMAIN_CHALLENGE = /^(.*)\/\.well-known\/am-domain\/([^/]+)\/?$/;

export function isDomainChallengePath(path: string): boolean {
  return DOMAIN_CHALLENGE.test(path);
}

/** A path the public listener serves, whether or not a brand domain matched. */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(path) || isDomainChallengePath(path)) return true;
  if (isBrandPath(path)) return true;
  // A site that proxies /am here forwards the prefix unchanged (#185). The app strips a
  // registered prefix before routing, so only paths that start with a public root after some
  // prefix are allowed through; an unregistered prefix still ends in the app's own 404.
  const roots = '(?:f|u|c|a|n|hooks)(?:/|$)';
  return new RegExp(`^/[^/]+(?:/[^/]+)*/${roots}`).test(path) || /\/(?:healthz|readyz)$/.test(path);
}

/** A brand-owned public path (/f, /u, /c, /a, /n, /hooks): Host resolution applies to these. */
export function isBrandPath(path: string): boolean {
  const root = path.split('/')[1] ?? '';
  return PUBLIC_ROOTS.has(root);
}

/**
 * The path prefix a Host serves (a verified brand domain's, or PUBLIC_LINKS_URL's), so a prefixed
 * path is only let through when that prefix is really registered for the host.
 */
export type PrefixOf = (host: string, path: string) => Promise<string | null>;

export function publicOnly(app: Hono, prefixOf?: PrefixOf) {
  const pub = new Hono();
  pub.use('*', rejectUnsafeRawPath);
  pub.all('*', async (c) => {
    const path = c.req.path;
    if (!isPublicPath(path)) return c.json({ error: 'not_found', message: 'Not found.' }, 404);
    // A prefixed public root (`/am/f/…`) only passes for the prefix this host serves; any other
    // prefix would otherwise fall through to the app's catch-all.
    const direct = isBrandPath(path) || PUBLIC_EXACT.has(path) || isDomainChallengePath(path);
    if (!direct && prefixOf) {
      const prefix = await prefixOf(c.req.header('host') ?? '', path);
      if (!prefix || !(path === prefix || path.startsWith(`${prefix}/`))) return c.json({ error: 'not_found', message: 'Not found.' }, 404);
    }
    return app.fetch(c.req.raw, c.env);
  });
  return pub;
}
