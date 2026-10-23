import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';

// Paths the API owns. They must keep returning JSON (or their own 404), never the SPA shell.
export const API_PATH_PREFIXES = ['/api', '/v1', '/mcp', '/f', '/u', '/c', '/.well-known', '/healthz', '/readyz', '/openapi.json'] as const;

/**
 * Serves a built single-page app from `root`: real files with their content types, and
 * `index.html` as the fallback for extension-less navigation paths. An asset request that names a
 * file (e.g. `/assets/missing.js`) is a 404 rather than the page, so a broken script does not
 * become HTML. Only GET/HEAD are handled, API paths pass through, and a missing directory is a
 * no-op (a server-only install behaves as before).
 */
export function staticSite({ root, exclude = API_PATH_PREFIXES }: { root: string; exclude?: readonly string[] }): MiddlewareHandler {
  if (!existsSync(root)) return async (_c, next) => next();

  const serveFile = serveStatic({ root });
  const serveIndex = serveStatic({ root, path: 'index.html' });

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

    const path = c.req.path;
    if (exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next();

    if (extname(path)) {
      // A missing file with an extension is a 404: never answer an asset request with the page.
      const served = await serveFile(c, async () => {
        c.res = await c.notFound();
      });
      return served ?? c.res;
    }
    const served = await serveFile(c, async () => {
      const res = await serveIndex(c, next);
      if (res) c.res = res;
    });
    return served ?? c.res;
  };
}
