import { MAX_ORIGIN_LENGTH, originPatternHasWildcard, originPatternMatches, serializeTrustedOrigin } from '@agentic-marketing/core';

// Better Auth validates `Origin` itself for every cookie-bearing non-GET `/api/auth/*` request: it
// compiles each configured `trustedOrigins` entry into a backtracking RegExp and runs it against
// the attacker-controlled `Origin` or `Referer` header, with no length cap (#947). A four-wildcard
// entry (`https://*.*.*:*`, the most an operator may configure) against a few KB of dots pins the
// event loop for minutes.
//
// So Better Auth never receives a wildcard. It gets the exact entries, and a function that adds the
// serialized origins this request names — its `Origin` (or `Referer`), and the callback URLs Better
// Auth validates against the same list — when our bounded matcher says a wildcard covers them. The
// function form is Better Auth 1.7's supported `trustedOrigins` shape (`(request) => string[]`),
// resolved once per request by `getTrustedOrigins`; without a request — at context creation, and on
// the `auth.api` direct path — only the exact entries are returned.
//
// Every value returned here is a serialized origin with no `*` or `?` in it. `new URL` keeps a
// literal `*` and decodes `%2a` to one, so a request could otherwise have its own header handed
// back as a fresh pattern for Better Auth to compile (review of #947).

/** The callback fields Better Auth validates against `trustedOrigins` (`originCheckMiddleware`). */
const CALLBACK_FIELDS = ['callbackURL', 'redirectTo', 'errorCallbackURL', 'newUserCallbackURL'] as const;

/** A wildcard character is never part of an origin: Better Auth would compile it as a pattern. */
const hasWildcardCharacter = (value: string): boolean => value.includes('*') || value.includes('?');

/**
 * The serialized origin of a URL, or null when it is not one, is longer than any browser sends, or
 * carries a wildcard character — literal or decoded from `%2a`.
 */
function serializedOrigin(value: string): string | null {
  if (!value || value.length > MAX_ORIGIN_LENGTH) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' || hasWildcardCharacter(origin) ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The origin a request names, serialized the way Better Auth compares it: its `Origin`, or its
 * `Referer` when there is no Origin (the header order Better Auth itself reads).
 */
function requestOrigin(headers: Headers): string | null {
  const header = headers.get('origin') || headers.get('referer');
  return header ? serializedOrigin(header) : null;
}

/**
 * The origins of the callback URLs Better Auth validates against the same trusted list. The values
 * come from the query and the body, exactly where Better Auth reads them. The body is read through
 * a clone, so the request Better Auth parses afterwards is untouched.
 */
async function callbackOrigins(request: Request): Promise<string[]> {
  const values: unknown[] = [];
  try {
    const url = new URL(request.url);
    for (const field of CALLBACK_FIELDS) values.push(url.searchParams.get(field));
  } catch {
    // A request URL the platform cannot parse has no query to read.
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/json' || type === 'application/x-www-form-urlencoded') {
      try {
        const text = await request.clone().text();
        if (type === 'application/json') {
          const body = JSON.parse(text) as Record<string, unknown> | null;
          for (const field of CALLBACK_FIELDS) values.push(body?.[field]);
        } else {
          const form = new URLSearchParams(text);
          for (const field of CALLBACK_FIELDS) values.push(form.get(field));
        }
      } catch {
        // A body Better Auth cannot parse either: it names no callback origin.
      }
    }
  }
  return values.flatMap((value) => (typeof value === 'string' ? (serializedOrigin(value) ?? []) : []));
}

/**
 * The `trustedOrigins` to hand to Better Auth (#947). Exact entries are normalized to their
 * serialized origin; wildcard entries stay out of the array entirely and are resolved per request
 * with the bounded matcher in `@agentic-marketing/core`, into the origins the request names.
 *
 * The result never contains `*` or `?`, so nothing Better Auth compiles can backtrack.
 */
export function betterAuthTrustedOrigins(entries: readonly string[] = []): (request?: Request) => Promise<string[]> {
  const exact = new Set<string>();
  const wildcards: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (originPatternHasWildcard(trimmed)) wildcards.push(trimmed);
    else {
      // An entry that only becomes a wildcard after normalization (`%2a` in a host) names no origin
      // a browser can send, so it is dropped rather than handed over as a pattern.
      const serialized = serializeTrustedOrigin(trimmed);
      if (serialized && !hasWildcardCharacter(serialized)) exact.add(serialized);
    }
  }
  const staticOrigins = [...exact];
  return async (request?: Request): Promise<string[]> => {
    const origins = [...staticOrigins];
    if (!request || wildcards.length === 0) return origins;
    const candidates = [requestOrigin(request.headers), ...(await callbackOrigins(request))];
    for (const candidate of candidates) {
      if (candidate === null || origins.includes(candidate)) continue;
      if (wildcards.some((pattern) => originPatternMatches(candidate, pattern))) origins.push(candidate);
    }
    return origins;
  };
}
