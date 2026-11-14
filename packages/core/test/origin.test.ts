import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { MAX_ORIGIN_LENGTH, MAX_PATTERN_LENGTH, originPatternMatches, originPatternProblem } from '../src/origin';

// #902: the same TRUSTED_ORIGINS list is validated by Better Auth for `/api/auth/*` and by the
// CSRF check for every cookie-authenticated write. The two must agree, so an IP wildcard never
// turns into a domain, a wildcard never runs past the host, and a long or highly starred pattern
// cannot make the check expensive.

const matches = (origin: string, pattern: string) => originPatternMatches(origin, pattern);

describe('an IP-range wildcard only matches an IPv4 address (#902)', () => {
  it('refuses a hostname in a digit-dot wildcard', () => {
    expect(matches('https://192.168.evil.com', 'https://192.168.*.*')).toBe(false);
    expect(matches('https://10.evil.example', 'https://10.*')).toBe(false);
    expect(matches('https://10.0.0.1.evil.com', 'https://10.*')).toBe(false);
  });

  it('accepts a literal IPv4 address in the range', () => {
    expect(matches('https://192.168.1.5', 'https://192.168.*.*')).toBe(true);
    expect(matches('https://192.168.0.1', 'https://192.168.*.*')).toBe(true);
    expect(matches('https://10.1.2.3', 'https://10.*.*.*')).toBe(true);
  });

  it('refuses an octet that is not an address', () => {
    expect(matches('https://192.168.1.256', 'https://192.168.*.*')).toBe(false);
    // Five octets are not an IPv4 address either.
    expect(matches('https://192.168.1.5.6', 'https://192.168.*.*')).toBe(false);
    // A non-canonical spelling is serialized by the URL parser before either matcher sees it, so
    // `192.168.0001.5` is the same origin as `192.168.1.5` here and in Better Auth.
    expect(matches('https://192.168.0001.5', 'https://192.168.*.*')).toBe(true);
  });

  it('does not let a wildcard run past the host into a port', () => {
    // `*` never matches `:`, so a pattern without a port covers the host only.
    expect(matches('https://192.168.1.5:8443', 'https://192.168.*.*')).toBe(false);
    expect(matches('https://192.168.1.5:8443', 'https://192.168.*.*:*')).toBe(true);
    expect(matches('https://a.example.com:8443', 'https://*.example.com')).toBe(false);
    expect(matches('https://a.example.com:8443', 'https://*.example.com:8443')).toBe(true);
  });
});

describe('a wildcard stays inside the host', () => {
  it('matches a subdomain and, like Better Auth, a deeper name under the listed domain', () => {
    expect(matches('https://a.example.com', 'https://*.example.com')).toBe(true);
    expect(matches('https://a.b.example.com', 'https://*.example.com')).toBe(true);
  });

  it('refuses an attacker suffix or prefix around the listed domain', () => {
    expect(matches('https://evil.com.example.com.attacker.net', 'https://*.example.com')).toBe(false);
    expect(matches('https://example.com.evil.net', 'https://*.example.com')).toBe(false);
    expect(matches('https://evil-example.com', 'https://*.example.com')).toBe(false);
  });

  it('does not let a scheme differ, and never crosses a path separator', () => {
    expect(matches('http://example.com', 'https://example.com')).toBe(false);
    expect(matches('https://example.com', 'http://example.com')).toBe(false);
    expect(matches('http://a.example.com', 'https://*.example.com')).toBe(false);
    // A `/` in a pattern is literal; a browser never puts one in an Origin.
    expect(matches('https://a.example.com', 'https://*/*.example.com')).toBe(false);
  });

  it('treats a pattern without a scheme as a host pattern', () => {
    expect(matches('https://a.example.com', '*.example.com')).toBe(true);
    expect(matches('https://evil.net', '*.example.com')).toBe(false);
    expect(matches('http://a.example.com', '*.example.com')).toBe(true);
  });
});

describe('an exact entry', () => {
  it('matches itself and nothing beside it', () => {
    expect(matches('https://app.example.com', 'https://app.example.com')).toBe(true);
    expect(matches('https://app.example.com:8443', 'https://app.example.com')).toBe(false);
    expect(matches('https://app.example.com', 'https://app.example.com:8443')).toBe(false);
    expect(matches('https://app.example.com.evil.net', 'https://app.example.com')).toBe(false);
    expect(matches('https://evil.example.com', 'https://app.example.com')).toBe(false);
    expect(matches('http://localhost:3100', 'http://localhost:3100')).toBe(true);
  });

  // This is the normalisation the CSRF check has always applied, and it is what Better Auth's own
  // `getOrigin` comparison does not: an entry written with a trailing slash, an upper-case host or
  // an explicit default port names the same origin, and the CSRF check has accepted it since before
  // #902 (Better Auth refuses it, so that entry was already unusable for `/api/auth/*`).
  it('is normalised the way it always was: trailing slash, case, default port', () => {
    expect(matches('https://example.com', 'https://example.com/')).toBe(true);
    expect(matches('https://example.com', 'https://EXAMPLE.COM')).toBe(true);
    expect(matches('https://example.com', 'HTTPS://Example.Com/')).toBe(true);
    expect(matches('https://example.com', 'https://example.com:443')).toBe(true);
    expect(matches('http://example.com:8080', 'http://example.com:8080/')).toBe(true);
    // Normalising an entry never widens it to another host.
    expect(matches('https://example.com.evil.net', 'https://example.com/')).toBe(false);
  });
});

describe('a wildcard entry is normalised in its spelling only', () => {
  it('lower-cases the scheme and host and drops a trailing slash', () => {
    expect(matches('https://a.example.com', 'HTTPS://*.EXAMPLE.COM/')).toBe(true);
    expect(matches('https://a.example.com', 'https://*.Example.Com')).toBe(true);
    expect(matches('https://a.example.com', 'https://*.example.com/')).toBe(true);
    expect(matches('https://a.example.com', '*.Example.COM/')).toBe(true);
    // The same normalisation does not let a host outside the entry in.
    expect(matches('https://a.example.com.evil.net', 'HTTPS://*.EXAMPLE.COM/')).toBe(false);
  });
});

describe('matching is bounded', () => {
  it('refuses an Origin header longer than any browser sends', () => {
    const long = `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com`;
    expect(long.length).toBeGreaterThan(MAX_ORIGIN_LENGTH);
    expect(matches(long, 'https://*.example.com')).toBe(false);
  });

  it('names the pattern it will not accept', () => {
    expect(originPatternProblem('https://*.example.com')).toBeNull();
    expect(originPatternProblem('   ')).toBe('is empty');
    expect(originPatternProblem('https://*a*a*a*a*a.example.com')).toBe('has more than 4 wildcards');
    expect(originPatternProblem(`https://${'a'.repeat(MAX_PATTERN_LENGTH)}.example.com`)).toContain('longer than');
    expect(originPatternProblem('https://exa\u0000mple.com')).toBe('contains a control character');
    // A pattern the loader refuses never matches, whatever the origin.
    expect(matches('https://aaaaaa.example.com', 'https://*a*a*a*a*a.example.com')).toBe(false);
  });

  // The compiled `[^/]*?` pattern this replaced backtracked super-linearly with several stars: a
  // long run of `a` followed by a mismatch made one `*` try every split of the run for each star.
  it('matches a long origin in bounded time however many stars the pattern has', () => {
    const pattern = 'https://*a*a*a*a.example.com';
    expectLinear(
      (n) => `https://${'a'.repeat(n)}b.example.com`,
      (origin) => originPatternMatches(origin, pattern),
      4_000,
    );
    expectLinear(
      (n) => `https://${'a'.repeat(n)}.example.com`,
      (origin) => originPatternMatches(origin, 'https://*a*.example.com'),
      4_000,
    );
  });
});

describe('originPatternMatches fails closed', () => {
  it('refuses a value that is not an origin', () => {
    expect(matches('null', 'https://example.com')).toBe(false);
    expect(matches('', 'https://example.com')).toBe(false);
    expect(matches('not a url', 'https://example.com')).toBe(false);
    expect(matches('https://example.com', 'not a url')).toBe(false);
  });
});
