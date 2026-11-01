import type { MiddlewareHandler } from 'hono';

// Baseline security headers on every response (#178): the admin UI, the API, health checks and
// the public routes. A route that sets its own header keeps it, so the stricter policies of hosted
// pages, the archive and assets stay as they are; these are only defaults.
//
// - nosniff and a referrer policy everywhere;
// - no framing (X-Frame-Options and CSP frame-ancestors), so an approval click cannot be hijacked;
//   the admin UI's previews use srcdoc iframes, which these headers do not affect;
// - camera, microphone and geolocation off;
// - HSTS when the server's public URL is HTTPS. A proxy in front may set it as well; the app only
//   adds it when the response does not have it yet.

/** One year: long enough to matter, the usual minimum for HSTS preload lists. */
export const HSTS_MAX_AGE = 31_536_000;

export function securityHeaders(opts: {
  https: boolean;
  /** Paths whose responses must not leak their URL (e.g. a reset token) to any referrer. */
  noReferrerPaths?: string[];
}): MiddlewareHandler {
  const defaults: [string, string][] = [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['X-Frame-Options', 'DENY'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
    ...(opts.https ? ([['Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}`]] as [string, string][]) : []),
  ];
  return async (c, next) => {
    await next();
    // A response passed through from fetch() has immutable headers: copy it once.
    try {
      c.res.headers.set('X-Content-Type-Options', c.res.headers.get('X-Content-Type-Options') ?? 'nosniff');
    } catch {
      c.res = new Response(c.res.body, c.res);
    }
    const headers = c.res.headers;
    for (const [name, value] of defaults) if (!headers.has(name)) headers.set(name, value);
    // A page that carries a secret in its query string (the password reset link, #191) tells every
    // browser not to send it on, so a same-origin asset request cannot put the token in a Referer.
    const path = c.req.path;
    if (opts.noReferrerPaths?.some((p) => path === p || path.startsWith(`${p}/`))) headers.set('Referrer-Policy', 'no-referrer');
    // A page without its own policy may not be framed either (the SPA shell). Only frame-ancestors:
    // a script/style policy for the admin UI is a separate change.
    if (!headers.has('Content-Security-Policy') && headers.get('Content-Type')?.startsWith('text/html'))
      headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  };
}
