import { MAX_ORIGIN_LENGTH, originPatternHasWildcard, originPatternMatches, serializeTrustedOrigin } from '@agentic-marketing/core';

// Better Auth validates `Origin` itself for every cookie-bearing non-GET `/api/auth/*` request: it
// compiles each configured `trustedOrigins` entry into a backtracking RegExp and runs it against
// the attacker-controlled `Origin` or `Referer` header, with no length cap (#947). A four-wildcard
// entry (`https://*.*.*:*`, the most an operator may configure) against a few KB of dots pins the
// event loop for minutes.
//
// So Better Auth never receives a wildcard. It gets the exact entries, and a function that adds the
// one serialized origin this request names when our bounded matcher says a wildcard covers it. The
// function form is Better Auth 1.7's supported `trustedOrigins` shape (`(request) => string[]`),
// resolved once per request by `getTrustedOrigins`; without a request — at context creation, and on
// the `auth.api` direct path — only the exact entries are returned.

/**
 * The origin a request names, serialized the way Better Auth compares it: its `Origin`, or its
 * `Referer` when there is no Origin (which is the header order Better Auth itself reads). Null when
 * neither names a usable origin, and for a header longer than any browser sends — that request is
 * refused before it gets here, and the matcher refuses it anyway.
 */
function requestOrigin(headers: Headers): string | null {
  const header = headers.get('origin') || headers.get('referer');
  if (!header || header.length > MAX_ORIGIN_LENGTH) return null;
  try {
    const origin = new URL(header).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The `trustedOrigins` to hand to Better Auth (#947). Exact entries are normalized to their
 * serialized origin; wildcard entries stay out of the array entirely and are resolved per request
 * with the bounded matcher in `@agentic-marketing/core`, into the single origin the request names.
 *
 * The result never contains `*` or `?`, so nothing Better Auth compiles can backtrack.
 */
export function betterAuthTrustedOrigins(entries: readonly string[] = []): (request?: Request) => string[] {
  const exact = new Set<string>();
  const wildcards: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (originPatternHasWildcard(trimmed)) wildcards.push(trimmed);
    else exact.add(serializeTrustedOrigin(trimmed));
  }
  const staticOrigins = [...exact];
  return (request?: Request): string[] => {
    if (!request || wildcards.length === 0) return [...staticOrigins];
    const origin = requestOrigin(request.headers);
    if (origin === null) return [...staticOrigins];
    if (staticOrigins.includes(origin)) return [...staticOrigins];
    return wildcards.some((pattern) => originPatternMatches(origin, pattern)) ? [...staticOrigins, origin] : [...staticOrigins];
  };
}
