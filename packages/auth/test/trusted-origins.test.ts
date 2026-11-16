import { MAX_ORIGIN_LENGTH } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { betterAuthTrustedOrigins } from '../src/trustedOrigins';

// #947: Better Auth compiles every entry it is given into a backtracking regular expression and
// runs it against the attacker-controlled Origin (or Referer) of a cookie-bearing `/api/auth/*`
// write, with no length cap. So it must never receive a wildcard: the wildcard entries are resolved
// here, with the bounded matcher in core, into the one serialized origin this request names.

const request = (headers: Record<string, string>) => new Request('https://marketing.example.com/api/auth/sign-out', { headers });

const entries = ['https://app.example.com/', 'https://*.example.com', 'https://192.168.*.*:*', 'https://*.example.com:443'];

describe('the trusted origins handed to Better Auth (#947)', () => {
  it('never contains a wildcard, whatever the request', () => {
    const resolve = betterAuthTrustedOrigins(entries);
    const lists = [
      resolve(),
      resolve(request({ origin: 'https://a.example.com' })),
      resolve(request({ referer: 'https://b.example.com/login?next=/x' })),
      resolve(request({ origin: 'https://evil.example.net' })),
      resolve(request({ origin: `https://${'.'.repeat(MAX_ORIGIN_LENGTH)}x` })),
    ];
    for (const list of lists)
      for (const value of list) {
        expect(value).not.toContain('*');
        expect(value).not.toContain('?');
      }
  });

  it('hands Better Auth the exact entries in their serialized form, and nothing else, without a request', () => {
    expect(betterAuthTrustedOrigins(entries)()).toEqual(['https://app.example.com']);
  });

  it('adds the request origin when it matches a wildcard entry', () => {
    const resolve = betterAuthTrustedOrigins(entries);
    expect(resolve(request({ origin: 'https://a.example.com' }))).toEqual(['https://app.example.com', 'https://a.example.com']);
    // A Referer stands in for a missing Origin, as Better Auth itself reads them.
    expect(resolve(request({ referer: 'https://b.example.com/login?next=/x' }))).toEqual([
      'https://app.example.com',
      'https://b.example.com',
    ]);
    // An Origin wins over a Referer, again as Better Auth reads them.
    expect(resolve(request({ origin: 'https://c.example.com', referer: 'https://evil.example.net/x' }))).toEqual([
      'https://app.example.com',
      'https://c.example.com',
    ]);
  });

  it('adds nothing an entry does not cover', () => {
    const resolve = betterAuthTrustedOrigins(entries);
    expect(resolve(request({ origin: 'https://evil.example.net' }))).toEqual(['https://app.example.com']);
    expect(resolve(request({ origin: 'https://example.com.evil.net' }))).toEqual(['https://app.example.com']);
    expect(resolve(request({ origin: 'null' }))).toEqual(['https://app.example.com']);
    expect(betterAuthTrustedOrigins(['https://*.example.com'])(request({ origin: 'http://a.example.com' }))).toEqual([]);
  });

  it('drops a default port from a wildcard entry, so a browser origin still matches (#943)', () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com:443']);
    expect(resolve(request({ origin: 'https://a.example.com' }))).toEqual(['https://a.example.com']);
    expect(resolve(request({ origin: 'https://a.example.com:443' }))).toEqual(['https://a.example.com']);
  });

  it('does not resolve a header longer than any browser sends', () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    expect(resolve(request({ origin: `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com` }))).toEqual([]);
    expect(resolve(request({ referer: `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com/x` }))).toEqual([]);
  });

  it('has no wildcard at all when the configuration only names exact origins', () => {
    const resolve = betterAuthTrustedOrigins(['https://app.example.com', 'http://localhost:3100/']);
    expect(resolve(request({ origin: 'https://app.example.com' }))).toEqual(['https://app.example.com', 'http://localhost:3100']);
  });
});
