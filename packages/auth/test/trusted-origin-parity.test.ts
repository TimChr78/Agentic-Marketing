import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { originPatternMatches } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';

// #902: `TRUSTED_ORIGINS` has two consumers — Better Auth for `/api/auth/*`, and the CSRF check in
// front of every cookie-authenticated write. If they disagree, one class of request is refused at
// sign-in while the other is accepted, so this asserts they agree on a table of origins. Better
// Auth does not export its matcher from the package root; the module is loaded from its own dist,
// which is the one the running server uses.

const require = createRequire(import.meta.url);

async function betterAuthMatcher(): Promise<(url: string, pattern: string) => boolean> {
  const entry = require.resolve('better-auth');
  const module = (await import(pathToFileURL(join(dirname(entry), 'auth/trusted-origins.mjs')).href)) as {
    matchesOriginPattern: (url: string, pattern: string) => boolean;
  };
  return module.matchesOriginPattern;
}

const patterns = [
  'https://app.example.com',
  'https://192.168.*.*',
  'https://10.*',
  'https://*.example.com',
  'https://preview-*.example.com',
  'https://*.example.com:8443',
  'https://app.example.com:8443',
  'http://localhost:3100',
  '*.example.com',
];

const origins = [
  'https://app.example.com',
  'https://app.example.com:8443',
  'https://app.example.com.evil.net',
  'https://evil.example.com',
  'https://192.168.evil.com',
  'https://192.168.1.5',
  'https://10.0.0.7',
  'https://10.evil.example',
  'https://a.example.com',
  'https://a.b.example.com',
  'https://evil.com.example.com.attacker.net',
  'https://example.com.evil.net',
  'https://preview-42.example.com',
  'http://localhost:3100',
  'http://localhost:3101',
  'http://app.example.com',
];

// The table holds every shape the two matchers must answer identically. Two deliberate
// differences are kept out of it and asserted below: our `*` cannot cross a `:` (Better Auth's can,
// so its `https://192.168.*.*` also matches `https://192.168.1.5:8443`), and we normalise the
// spelling of an entry (a trailing slash, upper case) where Better Auth compares it verbatim.
describe('the CSRF origin matcher agrees with Better Auth (#902)', () => {
  it('returns the same answer for every pattern and origin in the table', async () => {
    const betterAuth = await betterAuthMatcher();
    const disagreements: string[] = [];
    for (const pattern of patterns)
      for (const origin of origins) {
        const theirs = betterAuth(origin, pattern);
        const ours = originPatternMatches(origin, pattern);
        if (theirs !== ours) disagreements.push(`${pattern} vs ${origin}: better-auth ${theirs}, ours ${ours}`);
      }
    expect(disagreements).toEqual([]);
  });

  it('is deliberately stricter only where a wildcard would have to cross a port', async () => {
    const betterAuth = await betterAuthMatcher();
    const origin = 'https://192.168.1.5:8443';
    const pattern = 'https://192.168.*.*';
    // Better Auth's `*` spans the `:`; ours stops at the host, so the pattern has to name the port.
    expect(betterAuth(origin, pattern)).toBe(true);
    expect(originPatternMatches(origin, pattern)).toBe(false);
    expect(originPatternMatches(origin, 'https://192.168.*.*:*')).toBe(true);
  });

  it('covers both an allow and a refusal in the table, so parity is not vacuous', async () => {
    const betterAuth = await betterAuthMatcher();
    const answers = new Set(patterns.flatMap((pattern) => origins.map((origin) => betterAuth(origin, pattern))));
    expect(answers).toEqual(new Set([true, false]));
  });
});
