import { MAX_ORIGIN_LENGTH } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { betterAuthTrustedOrigins } from '../src/trustedOrigins';

// #947: Better Auth compiles every entry it is given into a backtracking regular expression and
// runs it against the attacker-controlled Origin (or Referer) of a cookie-bearing `/api/auth/*`
// write, with no length cap. So it must never receive a wildcard: the wildcard entries are resolved
// here, with the bounded matcher in core, into the one serialized origin this request names.
//
// A resolved origin must never contain `*` or `?` either: `new URL` keeps a literal `*` and decodes
// `%2a` to one, so returning such a header as an "exact" entry would hand Better Auth a new pattern.

const request = (headers: Record<string, string>, body?: BodyInit, method = body === undefined ? 'GET' : 'POST') =>
  new Request('https://marketing.example.com/api/auth/sign-out', { method, headers, body });

const json = (headers: Record<string, string>, body: unknown) =>
  request({ 'content-type': 'application/json', ...headers }, JSON.stringify(body));

const entries = ['https://app.example.com/', 'https://*.example.com', 'https://192.168.*.*:*', 'https://*.example.com:443'];

const wildcardFree = (list: string[]) => list.every((value) => !value.includes('*') && !value.includes('?'));

describe('the trusted origins handed to Better Auth (#947)', () => {
  it('never contains a wildcard, whatever the request', async () => {
    const resolve = betterAuthTrustedOrigins(entries);
    const lists = [
      await resolve(),
      await resolve(request({ origin: 'https://a.example.com' })),
      await resolve(request({ referer: 'https://b.example.com/login?next=/x' })),
      await resolve(request({ origin: 'https://evil.example.net' })),
      await resolve(request({ origin: `https://${'.'.repeat(MAX_ORIGIN_LENGTH)}x` })),
      await resolve(json({ origin: 'https://a.example.com' }, { callbackURL: 'https://admin.example.com/after' })),
    ];
    for (const list of lists) expect(wildcardFree(list)).toBe(true);
  });

  it('hands Better Auth the exact entries in their serialized form, and nothing else, without a request', async () => {
    expect(await betterAuthTrustedOrigins(entries)()).toEqual(['https://app.example.com']);
  });

  it('adds the request origin when it matches a wildcard entry', async () => {
    const resolve = betterAuthTrustedOrigins(entries);
    expect(await resolve(request({ origin: 'https://a.example.com' }))).toEqual(['https://app.example.com', 'https://a.example.com']);
    // A Referer stands in for a missing Origin, as Better Auth itself reads them.
    expect(await resolve(request({ referer: 'https://b.example.com/login?next=/x' }))).toEqual([
      'https://app.example.com',
      'https://b.example.com',
    ]);
    // An Origin wins over a Referer, again as Better Auth reads them.
    expect(await resolve(request({ origin: 'https://c.example.com', referer: 'https://evil.example.net/x' }))).toEqual([
      'https://app.example.com',
      'https://c.example.com',
    ]);
  });

  it('adds nothing an entry does not cover', async () => {
    const resolve = betterAuthTrustedOrigins(entries);
    expect(await resolve(request({ origin: 'https://evil.example.net' }))).toEqual(['https://app.example.com']);
    expect(await resolve(request({ origin: 'https://example.com.evil.net' }))).toEqual(['https://app.example.com']);
    expect(await resolve(request({ origin: 'null' }))).toEqual(['https://app.example.com']);
    expect(await betterAuthTrustedOrigins(['https://*.example.com'])(request({ origin: 'http://a.example.com' }))).toEqual([]);
  });

  it('drops a default port from a wildcard entry, so a browser origin still matches (#943)', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com:443']);
    expect(await resolve(request({ origin: 'https://a.example.com' }))).toEqual(['https://a.example.com']);
    expect(await resolve(request({ origin: 'https://a.example.com:443' }))).toEqual(['https://a.example.com']);
  });

  it('does not resolve a header longer than any browser sends', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    expect(await resolve(request({ origin: `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com` }))).toEqual([]);
    expect(await resolve(request({ referer: `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com/x` }))).toEqual([]);
  });

  it('has no wildcard at all when the configuration only names exact origins', async () => {
    const resolve = betterAuthTrustedOrigins(['https://app.example.com', 'http://localhost:3100/']);
    expect(await resolve(request({ origin: 'https://app.example.com' }))).toEqual(['https://app.example.com', 'http://localhost:3100']);
  });

  // Review A: the origin a request names can itself carry wildcard characters, literally or after
  // URL decoding (`%2a`). Returning it would give Better Auth a fresh pattern to compile.
  it('never returns an origin that carries a wildcard, literal or percent-encoded', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com', 'https://?.example.com']);
    const star = 'https://*.*.*.*.*.*.*.*.example.com';
    for (const headers of [
      { origin: star },
      { referer: `${star}/login` },
      { origin: 'https://%2a.example.com' },
      { referer: 'https://%2a.example.com/x' },
    ] as Record<string, string>[]) {
      const list = await resolve(request(headers));
      expect(list).toEqual([]);
      expect(wildcardFree(list)).toBe(true);
    }
    // A `?` cannot appear in a serialized origin (the parser refuses the host, and a query is not
    // part of one), so the header is refused rather than resolved.
    expect(await resolve(request({ origin: 'https://?.example.com' }))).toEqual([]);
    expect(await resolve(request({ referer: 'https://?.example.com/x' }))).toEqual([]);
  });

  it('drops an exact entry whose serialized form is a wildcard, instead of handing it over', async () => {
    const resolve = betterAuthTrustedOrigins(['https://%2a.example.com']);
    // `%2a` decodes to `*` inside a host, so the entry names no origin a browser can send.
    expect(await resolve()).toEqual([]);
    expect(await resolve(request({ origin: 'https://a.example.com' }))).toEqual([]);
  });
});

// Review B: Better Auth also validates the callback URLs a request carries against the same list,
// so a wildcard-covered callback origin must be resolved too — otherwise every cross-subdomain
// redirect the wildcard used to allow is refused.
describe('the callback origins handed to Better Auth (#947)', () => {
  it('adds the origin of a JSON body callback URL that a wildcard covers', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    expect(
      await resolve(json({ origin: 'https://app.example.com' }, { email: 'a@b.c', callbackURL: 'https://admin.example.com/after?x=1' })),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('reads every field Better Auth validates, from the body and the query', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    const list = await resolve(
      json(
        { origin: 'https://app.example.com' },
        {
          callbackURL: 'https://one.example.com/after',
          redirectTo: 'https://two.example.com/after',
          errorCallbackURL: 'https://three.example.com/after',
          newUserCallbackURL: 'https://four.example.com/after',
        },
      ),
    );
    expect(list).toEqual([
      'https://app.example.com',
      'https://one.example.com',
      'https://two.example.com',
      'https://three.example.com',
      'https://four.example.com',
    ]);
    const query = new URL('https://marketing.example.com/api/auth/sign-in/email');
    query.searchParams.set('callbackURL', 'https://five.example.com/after');
    expect(await resolve(new Request(query))).toEqual(['https://five.example.com']);
  });

  it('reads a urlencoded body without consuming it for Better Auth', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    const body = new URLSearchParams({ callbackURL: 'https://admin.example.com/after' }).toString();
    const req = request({ 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.example.com' }, body);
    expect(await resolve(req)).toEqual(['https://app.example.com', 'https://admin.example.com']);
    // The clone the resolver reads does not disturb the request Better Auth reads afterwards.
    expect(req.bodyUsed).toBe(false);
    expect(await req.text()).toBe(body);
  });

  it('adds nothing for a callback origin no entry covers, over the cap, or carrying a wildcard', async () => {
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    expect(await resolve(json({}, { callbackURL: 'https://evil.example.net/after' }))).toEqual([]);
    expect(await resolve(json({}, { callbackURL: `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com/after` }))).toEqual([]);
    expect(await resolve(json({}, { callbackURL: 'https://*.*.*.*.example.com/after' }))).toEqual([]);
    expect(await resolve(json({}, { callbackURL: 'https://%2a.example.com/after' }))).toEqual([]);
    expect(await resolve(json({}, { callbackURL: 'https://a.example.com/%2a' }))).toEqual(['https://a.example.com']);
  });

  it('adds a callback origin a `?` entry covers only when the origin itself is wildcard-free', async () => {
    const resolve = betterAuthTrustedOrigins(['https://?.example.com']);
    // The origin a request names cannot be serialized with `?` in it, so nothing is added.
    expect(await resolve(json({ origin: 'https://*.example.com' }, { callbackURL: 'https://long.example.com/cb' }))).toEqual([]);
  });

  it('does not trust a SAML RelayState callback origin', async () => {
    // The SAML ACS POST has no or a foreign Origin; its callback rides in RelayState, which Better
    // Auth does not validate against trustedOrigins as a callback URL. Only an exact entry covers it.
    const resolve = betterAuthTrustedOrigins(['https://*.example.com']);
    const body = new URLSearchParams({
      SAMLResponse: 'not-checked-here',
      RelayState: 'https://admin.example.com/dashboard',
    }).toString();
    expect(
      await resolve(request({ 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.net' }, body)),
    ).toEqual([]);
  });
});
