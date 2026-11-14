// Matching a browser's `Origin` against a `TRUSTED_ORIGINS` entry (#902).
//
// The same list is handed to Better Auth, which validates `Origin` itself for `/api/auth/*`. If the
// two matchers disagree, one class of request is refused at sign-in and accepted by every
// cookie-authenticated write, so this is a faithful port of Better Auth's rules (its
// `matchesOriginPattern`: a glob where `*` is any run and `?` one character, neither crossing `/`;
// no wildcard means an exact serialized origin; and a wildcard host made only of digits, dots and
// wildcards names an address range, so it admits only a literal IPv4 address).
//
// The last rule is the one that matters: without it `https://192.168.*.*` compiles to a pattern
// that also matches `https://192.168.evil.com`.

/** A literal IPv4 address, the same shape Better Auth's `z.ipv4()` accepts. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;

/** A host that is an address range rather than a name: digits, dots and wildcards. */
const IP_WILDCARD_HOST = /^(?=.*\d)[\d*?.]+$/;

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const quoted = (char: string) => char.replace(REGEXP_SPECIAL, '\\$&');

/**
 * A wildcard pattern as an anchored regular expression. `*` is any run and `?` one character, both
 * staying inside one path segment, which is how Better Auth compiles the same pattern.
 */
function wildcard(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '[^/\\\\]*?';
    else if (char === '?') source += '[^/\\\\]';
    else source += quoted(char);
  }
  return new RegExp(`^${source}$`);
}

/** The serialized origin of a URL (`https://host[:port]`), or null when it is not one. */
function serializedOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function protocolOf(value: string): string | null {
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

/**
 * Whether a digit-dot wildcard admits this authority. A pattern host that is only digits, dots and
 * wildcards names an IPv4 range (`192.168.*.*`, `10.*`), so the host must be a literal IPv4
 * address. Every other pattern keeps the documented subdomain matching.
 */
function admitsAuthority(patternAuthority: string, authority: string): boolean {
  const [patternHost = ''] = patternAuthority.split(':');
  if (!IP_WILDCARD_HOST.test(patternHost)) return true;
  const [host = ''] = authority.split(':');
  return IPV4.test(host);
}

/**
 * Whether an origin the browser sent is covered by one `TRUSTED_ORIGINS` entry. An entry is an
 * exact origin (`https://app.example.com`, port included) or a wildcard pattern
 * (`https://*.example.com`, `https://192.168.*.*`, `*.example.com`).
 *
 * A non-http scheme is compared as an exact origin: a browser does not put a custom-scheme origin
 * in `Origin`, and refusing an unrecognized shape fails closed.
 */
export function originPatternMatches(origin: string, pattern: string): boolean {
  const hasWildcard = pattern.includes('*') || pattern.includes('?');
  if (hasWildcard && !pattern.includes('://')) {
    // A host pattern (`*.example.com`): it names the host, not the origin.
    const host = hostOf(origin);
    if (!host) return false;
    return wildcard(pattern).test(host) && admitsAuthority(pattern, host);
  }
  const protocol = protocolOf(origin);
  if (protocol === 'http:' || protocol === 'https:' || !protocol) {
    if (!hasWildcard) return pattern === serializedOrigin(origin);
    const actual = serializedOrigin(origin);
    if (actual === null || !wildcard(pattern).test(actual)) return false;
    return admitsAuthority(pattern.slice(pattern.indexOf('://') + 3), actual.slice(actual.indexOf('://') + 3));
  }
  return pattern === serializedOrigin(origin);
}
