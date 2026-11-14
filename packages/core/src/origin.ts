// Matching a browser's `Origin` against a `TRUSTED_ORIGINS` entry (#902).
//
// The same list is handed to Better Auth, which validates `Origin` itself for `/api/auth/*`. If the
// two matchers disagree, one class of request is refused at sign-in and accepted by every
// cookie-authenticated write, so this follows Better Auth's rules (`matchesOriginPattern`):
//
// - an exact entry is a whole serialized origin: `https://app.example.com`, port included;
// - an entry may contain `*` (any run) and `?` (one character), which stay inside the authority and
//   never match `/`, `\`, `:` or `@`, so a wildcard cannot run past the host into another origin;
// - a wildcard host made only of digits, dots and wildcards names an address range (`192.168.*.*`,
//   `10.*`), so it admits only a literal IPv4 address. Without this rule `https://192.168.*.*`
//   would also match `https://192.168.evil.com`.
//
// `https://*.example.com` therefore covers `https://a.example.com` and `https://a.b.example.com`,
// exactly as it does for Better Auth: both are sub-domains of the operator's own domain, which is
// the conventional meaning of that entry.
//
// Entries are normalised the way the CSRF check always normalised them: an exact entry goes through
// `URL` (lower-case host, default port dropped, no trailing slash), and a wildcard entry has its
// scheme and host lower-cased and a trailing slash dropped. Better Auth compares a pattern verbatim,
// so it would refuse `https://Example.COM/` that this accepts — the same entry a wildcard-free
// configuration accepted before #902, and only the spelling of the entry, never a host the operator
// did not name.
//
// Matching is bounded: an Origin header over `MAX_ORIGIN_LENGTH` is refused without looking at it, an
// entry over `MAX_PATTERN_LENGTH` or with more than `MAX_PATTERN_WILDCARDS` wildcards is refused by
// the configuration loader, and the glob itself is the two-pointer match below, which visits every
// character of the origin a bounded number of times (`O(length × pattern)`, with the pattern capped).

/** The longest Origin header worth matching; a browser never sends one anywhere near this. */
export const MAX_ORIGIN_LENGTH = 2_048;
/** The longest `TRUSTED_ORIGINS` entry accepted at start-up. */
export const MAX_PATTERN_LENGTH = 512;
/** Wildcards per entry. Each one multiplies the match's work, and a real entry needs at most a few. */
export const MAX_PATTERN_WILDCARDS = 4;

/** A literal IPv4 address, the same shape Better Auth's `z.ipv4()` accepts. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;

/** A host that is an address range rather than a name: digits, dots and wildcards. */
const IP_WILDCARD_HOST = /^(?=.*\d)[\d*?.]+$/;

/** Whether a value contains a control character, which no origin or entry may carry. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Whether a character may be consumed by `*` or `?`: a wildcard never runs past the host. */
function wildcardChar(char: string): boolean {
  return char !== '/' && char !== '\\' && char !== ':' && char !== '@';
}

/**
 * The two-pointer wildcard match: `*` is a run of wildcard characters, `?` exactly one, everything
 * else is literal. The only backtrack point is the last `*`, so the work is bounded by
 * `origin.length × pattern.length` and never explodes with several stars the way a compiled
 * `[^/]*?` pattern does.
 */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let starStart = 0;
  while (t < text.length) {
    const char = pattern[p];
    if (char === '*') {
      star = p;
      starStart = t;
      p += 1;
      continue;
    }
    if (char !== undefined && (char === '?' ? wildcardChar(text[t]!) : char === text[t])) {
      p += 1;
      t += 1;
      continue;
    }
    if (star >= 0) {
      // Extend the last `*` by one character and try again; it may not swallow a separator.
      if (!wildcardChar(text[starStart]!)) return false;
      starStart += 1;
      t = starStart;
      p = star + 1;
      continue;
    }
    return false;
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
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

const hasWildcard = (pattern: string) => pattern.includes('*') || pattern.includes('?');

/**
 * An exact entry as a serialized origin. This is the normalisation the CSRF check has always done:
 * a trailing slash, an upper-case host and an explicit default port all name the same origin.
 */
function normalizeExact(entry: string): string {
  return serializedOrigin(entry.trim()) ?? entry.trim();
}

/**
 * A wildcard entry with the scheme and host lower-cased and a trailing slash dropped. Only the
 * spelling of the entry changes, never the set of hosts it covers.
 */
function normalizeWildcard(entry: string): string {
  const trimmed = entry.trim().replace(/\/+$/, '');
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd <= 0) return trimmed.toLowerCase();
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  const rest = trimmed.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = (authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)).toLowerCase();
  return `${scheme}://${authority}${authorityEnd === -1 ? '' : rest.slice(authorityEnd)}`;
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
 * Why a `TRUSTED_ORIGINS` entry cannot be used, or null when it can. The limits keep every match
 * bounded and are enforced when the configuration is loaded, so a bad entry fails at start-up with
 * a message that names it instead of at the first request.
 */
export function originPatternProblem(entry: string): string | null {
  const pattern = entry.trim();
  if (!pattern) return 'is empty';
  if (hasControlCharacter(pattern)) return 'contains a control character';
  if (pattern.length > MAX_PATTERN_LENGTH) return `is longer than ${MAX_PATTERN_LENGTH} characters`;
  const wildcards = [...pattern].filter((char) => char === '*' || char === '?').length;
  if (wildcards > MAX_PATTERN_WILDCARDS) return `has more than ${MAX_PATTERN_WILDCARDS} wildcards`;
  return null;
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
  if (!origin || origin.length > MAX_ORIGIN_LENGTH || originPatternProblem(pattern) !== null) return false;
  const wildcard = pattern.trim();
  const hasPatternWildcard = hasWildcard(wildcard);
  if (hasPatternWildcard && !wildcard.includes('://')) {
    // A host pattern (`*.example.com`): it names the host, not the origin.
    const host = hostOf(origin);
    if (!host) return false;
    return globMatches(normalizeWildcard(wildcard), host) && admitsAuthority(normalizeWildcard(wildcard), host);
  }
  const protocol = protocolOf(origin);
  if (protocol === 'http:' || protocol === 'https:' || !protocol) {
    const actual = serializedOrigin(origin);
    if (actual === null) return false;
    if (!hasPatternWildcard) return normalizeExact(wildcard) === actual;
    const normalised = normalizeWildcard(wildcard);
    if (!globMatches(normalised, actual)) return false;
    return admitsAuthority(normalised.slice(normalised.indexOf('://') + 3), actual.slice(actual.indexOf('://') + 3));
  }
  return normalizeExact(wildcard) === serializedOrigin(origin);
}
