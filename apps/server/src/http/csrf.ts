import { originPatternMatches } from '@agentic-marketing/core';
import type { Context } from 'hono';

// A session cookie is attached by the browser to a cross-site request whatever its content type, so
// a write authenticated by the cookie has to prove it came from the app. Two checks, both cheap:
//
// - the body must be JSON (or a form on the few form endpoints), so a page cannot send it as a
//   "simple" request through a form or `fetch` without a preflight;
// - the request must name this origin in `Origin`, or — when a client omits it — say
//   `Sec-Fetch-Site: same-origin`.
//
// Bearer-token requests never pass through here: a page cannot attach an Authorization header, and
// non-browser clients have no cookie to forge with. Better Auth's own /api/auth/* routes validate
// Origin against the same trusted list themselves.

export interface BrowserRequestPolicy {
  /** The public URL the app is served from; its origin is always trusted. */
  publicUrl: string;
  /** Extra origins allowed to call the app (TRUSTED_ORIGINS), e.g. a split UI host. */
  trustedOrigins: string[];
}

/** A command endpoint: the body is JSON, which a plain HTML form cannot send. */
export const JSON_BODY = ['application/json'] as const;
/** The server-rendered form endpoints: a native form posts urlencoded, still with an Origin. */
export const JSON_OR_FORM_BODY = ['application/json', 'application/x-www-form-urlencoded'] as const;

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

function isAllowedOrigin(origin: string, policy: BrowserRequestPolicy): boolean {
  const publicOrigin = originOf(policy.publicUrl);
  // A `TRUSTED_ORIGINS` entry is matched by the same rules Better Auth applies to its own routes
  // (#902): an exact origin, or a wildcard that never turns an IP range into a domain.
  return [...(publicOrigin ? [publicOrigin] : []), ...policy.trustedOrigins].some((allowed) => originPatternMatches(origin, allowed));
}

const refusal = (status: 403 | 415, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status, headers: { 'content-type': 'application/json' } });

/**
 * Refuses a browser request that a session cookie would authenticate but that did not come from
 * the app. Returns the response to send, or null when the request may proceed. The check is
 * method-agnostic for anything but a safe read, so a method-override header cannot skip it.
 */
export function csrfRefusal(req: Request, policy: BrowserRequestPolicy, bodyTypes: readonly string[] = JSON_BODY): Response | null {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const contentType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!bodyTypes.includes(contentType))
    return refusal(
      415,
      'unsupported_media_type',
      `Send this request as ${bodyTypes.join(' or ')}. A form or a cross-site fetch cannot write here.`,
    );

  const origin = req.headers.get('origin');
  if (origin !== null) {
    if (!isAllowedOrigin(origin, policy))
      return refusal(403, 'forbidden', 'This request came from another origin. Send it from the app itself, or use an API token.');
    return null;
  }
  // A browser that omits Origin still marks a same-origin request. Anything else (including no
  // marker at all) cannot prove it is not another site.
  if ((req.headers.get('sec-fetch-site') ?? '').trim().toLowerCase() === 'same-origin') return null;
  return refusal(403, 'forbidden', 'This request has no Origin. Send it from the app itself, or use an API token.');
}

/** The part of a Hono context these helpers read: the underlying request. */
type RawRequestContext = Pick<Context, 'req'>;

/** The same check for a Hono handler whose body may be JSON or a native form. */
export function formCsrfRefusal(c: RawRequestContext, policy: BrowserRequestPolicy): Response | null {
  return csrfRefusal(c.req.raw, policy, JSON_OR_FORM_BODY);
}

/** The body of a JSON or urlencoded form request, for the server-rendered form endpoints. */
export async function browserBody(c: RawRequestContext): Promise<Record<string, unknown>> {
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType === 'application/x-www-form-urlencoded') {
    const text = await c.req.text().catch(() => '');
    return Object.fromEntries(new URLSearchParams(text));
  }
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}
