// Agentic Marketing first-party proxy for a Cloudflare Pages site in advanced mode (_worker.js).
// Serves the platform's public surface under the site's own origin, at /am/*:
//   /am/f/<form>            signup forms (POST) and /am/f/confirm/<token> (double opt-in)
//   /am/u/<token>           unsubscribe (RFC 8058 one-click POST too)
//   /am/c/<token>           e-mail click redirects
//   /am/v1/batch, /am/v1/decide, /am/v1/consent/purposes   tracking, personalization and the
//                           consent banner's texts (only if the site uses the SDK)
// Everything else (admin UI, REST commands, MCP, OAuth) is NOT reachable through the site.
//
// Settings (Pages → Settings → Variables and secrets):
//   AM_ORIGIN       the platform's public hostname behind a Cloudflare Tunnel, e.g. https://am-edge.example.com
//   AM_ACCESS_ID    Cloudflare Access service token client id   (optional, recommended)
//   AM_ACCESS_SECRET Cloudflare Access service token secret     (optional, recommended)
// Platform settings: PUBLIC_LINKS_URL=https://<site>/am and CLIENT_IP_HEADER=x-am-client-ip.

const AM_PUBLIC = /^\/(f\/[A-Za-z0-9_./-]+|u\/[A-Za-z0-9_.-]+|c\/[A-Za-z0-9_.-]+|v1\/(batch|b|decide|consent\/purposes))$/;

export async function proxyAgenticMarketing(request, env, url) {
  const path = url.pathname.slice('/am'.length);
  if (!AM_PUBLIC.test(path) || !env.AM_ORIGIN) return new Response('Not found', { status: 404 });
  const target = new URL(path + url.search, env.AM_ORIGIN);
  const headers = new Headers();
  for (const h of ['content-type', 'accept', 'origin', 'referer', 'user-agent', 'authorization']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  // The visitor's IP, for rate limits and Turnstile; the platform reads it from CLIENT_IP_HEADER.
  headers.set('x-am-client-ip', request.headers.get('cf-connecting-ip') ?? '');
  if (env.AM_ACCESS_ID && env.AM_ACCESS_SECRET) {
    headers.set('cf-access-client-id', env.AM_ACCESS_ID);
    headers.set('cf-access-client-secret', env.AM_ACCESS_SECRET);
  }
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    redirect: 'manual',
  });
  const out = new Headers(res.headers);
  out.set('cache-control', 'no-store');
  out.delete('set-cookie');
  // Redirects to the platform's own paths stay on the site's /am prefix.
  const loc = out.get('location');
  if (loc?.startsWith(env.AM_ORIGIN)) out.set('location', `/am${loc.slice(env.AM_ORIGIN.replace(/\/$/, '').length)}`);
  return new Response(res.body, { status: res.status, headers: out });
}

// In _worker.js, first thing in fetch(), before the edge cache and asset logic:
//
//   import { proxyAgenticMarketing } from './am-proxy.js';
//   ...
//   if (url.pathname.startsWith('/am/')) return proxyAgenticMarketing(request, env, url);
