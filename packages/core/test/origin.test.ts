import { describe, expect, it } from 'vitest';
import { originPatternMatches } from '../src/origin';

// #902: the same TRUSTED_ORIGINS list is validated by Better Auth for `/api/auth/*` and by the
// CSRF check for every cookie-authenticated write. The two must agree, so a wildcard never crosses
// from an IP range into a registrable domain: `https://192.168.*.*` matches `192.168.1.5` and not
// `192.168.evil.com`.

const matches = (origin: string, pattern: string) => originPatternMatches(origin, pattern);

describe('an IP-range wildcard only matches an IPv4 address (#902)', () => {
  it('refuses a hostname in a digit-dot wildcard', () => {
    expect(matches('https://192.168.evil.com', 'https://192.168.*.*')).toBe(false);
    expect(matches('https://192.168.evil.com', 'https://192.168.*.*:*')).toBe(false);
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
});

describe('a wildcard never crosses the scheme or the path separator', () => {
  it('matches a subdomain and, like Better Auth, a deeper name under the listed domain', () => {
    expect(matches('https://a.example.com', 'https://*.example.com')).toBe(true);
    expect(matches('https://a.b.example.com', 'https://*.example.com')).toBe(true);
  });

  it('refuses an attacker suffix or prefix around the listed domain', () => {
    expect(matches('https://evil.com.example.com.attacker.net', 'https://*.example.com')).toBe(false);
    expect(matches('https://example.com.evil.net', 'https://*.example.com')).toBe(false);
    expect(matches('https://evil-example.com', 'https://*.example.com')).toBe(false);
  });

  it('does not let a scheme differ', () => {
    expect(matches('http://example.com', 'https://example.com')).toBe(false);
    expect(matches('https://example.com', 'http://example.com')).toBe(false);
    expect(matches('http://*.example.com', 'https://*.example.com')).toBe(false);
  });

  it('keeps an exact entry exact, port included', () => {
    expect(matches('https://app.example.com', 'https://app.example.com')).toBe(true);
    expect(matches('https://app.example.com:8443', 'https://app.example.com')).toBe(false);
    expect(matches('https://app.example.com', 'https://app.example.com:8443')).toBe(false);
    expect(matches('https://app.example.com.evil.net', 'https://app.example.com')).toBe(false);
    expect(matches('https://evil.example.com', 'https://app.example.com')).toBe(false);
    // The app's own origin, which is always trusted.
    expect(matches('http://localhost:3100', 'http://localhost:3100')).toBe(true);
  });

  it('treats a pattern without a scheme as a host pattern', () => {
    expect(matches('https://a.example.com', '*.example.com')).toBe(true);
    expect(matches('https://evil.net', '*.example.com')).toBe(false);
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
