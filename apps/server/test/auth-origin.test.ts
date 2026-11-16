// Better Auth skips its origin check when NODE_ENV is "test" (`isTest()` in @better-auth/core), so
// this file asks for the production behaviour before the auth package is loaded — the same way
// sso-origin.test.ts does. Everything else is the normal test harness.
import { MAX_ORIGIN_LENGTH } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { startTestServer as startServer, User } from './harness';

process.env.NODE_ENV = 'production';
// Vitest sets TEST=true, which @better-auth/core also reads as "test".
process.env.TEST = 'false';
const { PASSWORD, cookieOf, startTestServer, testPort } = await import('./harness');

// #947: Better Auth validates Origin itself for `/api/auth/*`, but it compiles each configured
// entry into a backtracking RegExp and runs it against the attacker's Origin or Referer with no
// length cap. A single request could therefore pin the event loop for minutes. The wildcard entries
// are resolved by the bounded matcher before Better Auth sees them, and an over-long header is
// refused before it reaches the auth handler at all.
//
// The timing assertions below only separate "answered" from "ran for minutes": a shared CI host
// schedules the request, so the bound is generous rather than the 1 ms the matcher itself costs.

/** The pathological request took 154 s and 171 s before the fix; anything near that fails here. */
const ANSWERED_MS = 2_000;

// A four-wildcard entry is the most an operator may configure (the release notes suggest
// `https://192.168.*.*:*` for a LAN), and the most expensive to match. The shape in the report,
// `https://*.*.*.*:*`, counts five wildcards and is already refused at start-up by the cap.
const WILDCARDS = 'https://*.*.*:*';
const LEGITIMATE = 'https://*.example.com';
const QUESTION = 'https://?.example.com';

let t: Awaited<ReturnType<typeof startServer>>;
let person: User;

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const authPost = (path: string, origin: string | null, cookie?: string, referer?: string) =>
  post(path, {
    ...(origin === null ? {} : { origin }),
    ...(referer === undefined ? {} : { referer }),
    ...(cookie === undefined ? {} : { cookie }),
  });

const signIn = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  post('/api/auth/sign-in/email', headers, { email: person.email, password: PASSWORD, ...body });

// Better Auth limits `/sign-in/email` to 3 requests per 10 s per IP, so a probe that only needs its
// origin checked uses `/update-user`: the router's origin check (Origin/Referer and any
// callbackURL in the body) runs before that endpoint's session middleware.
const probe = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  post('/api/auth/update-user', headers, { name: 'probe', ...body });

beforeAll(async () => {
  t = await startTestServer('auth_origin', testPort(2504), { TRUSTED_ORIGINS: `${WILDCARDS},${LEGITIMATE},${QUESTION}` });
  person = await t.signUp(`auth-origin-${Date.now()}@example.com`);
});

afterAll(async () => {
  await t?.close();
});

describe('the auth origin check is bounded (#947)', () => {
  it('answers an 8 KB dot-heavy Origin immediately, without reaching Better Auth', async () => {
    // The shape that took Better Auth >120 s with a four-wildcard entry.
    const origin = `https://${'.'.repeat(8 * 1024)}x`;
    const started = performance.now();
    const res = await authPost('/api/auth/sign-out', origin, person.cookie);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.stringContaining('longer than 2048') });
    expect(elapsed).toBeLessThan(ANSWERED_MS);
  });

  it('answers an 8 KB dot-heavy Referer immediately when there is no Origin', async () => {
    const referer = `https://${'.'.repeat(8 * 1024)}x/callback`;
    const started = performance.now();
    const res = await authPost('/api/auth/sign-out', null, person.cookie, referer);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.stringContaining('longer than 2048') });
    expect(elapsed).toBeLessThan(ANSWERED_MS);
  });

  it('still refuses a long header below the cap quickly, because Better Auth got no wildcard', async () => {
    // 400 dot-heavy characters cost Better Auth 1.6 s per request when it is handed the pattern.
    const origin = `https://${'.'.repeat(400)}x`;
    expect(origin.length).toBeLessThan(MAX_ORIGIN_LENGTH);
    const started = performance.now();
    const res = await authPost('/api/auth/sign-out', origin, person.cookie);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_ORIGIN');
    expect(elapsed).toBeLessThan(ANSWERED_MS);
  });

  // Review A: a request can name an origin that contains wildcard characters. Returning it would
  // hand Better Auth a new pattern to compile — the same stall through another door.
  it('refuses an Origin that carries wildcard characters, literal or percent-encoded', async () => {
    const star = 'https://*.*.*.*.*.*.*.*.example.com';
    const dotted = `https://${'.'.repeat(120)}x.example.net`;
    const cases: { origin: string; body?: Record<string, unknown> }[] = [
      { origin: star },
      { origin: star, body: { callbackURL: dotted } },
      { origin: 'https://%2a.example.com' },
      { origin: 'https://%2a.example.com', body: { callbackURL: dotted } },
      { origin: 'https://?.example.com' },
    ];
    for (const { origin, body } of cases) {
      const started = performance.now();
      const res = await probe({ origin, cookie: person.cookie }, body);
      const elapsed = performance.now() - started;
      expect(res.status, origin).toBe(403);
      expect((await res.json()).code, origin).toBe('INVALID_ORIGIN');
      expect(elapsed, origin).toBeLessThan(ANSWERED_MS);
    }
  });

  it('refuses a Referer that carries wildcard characters, literal or percent-encoded', async () => {
    const cases = [`https://${'*'.repeat(8)}.example.com/login`, 'https://%2a.example.com/login', 'https://?.example.com/login'];
    for (const referer of cases) {
      const started = performance.now();
      const res = await probe({ referer, cookie: person.cookie });
      const elapsed = performance.now() - started;
      expect(res.status, referer).toBe(403);
      expect((await res.json()).code, referer).toBe('INVALID_ORIGIN');
      expect(elapsed, referer).toBeLessThan(ANSWERED_MS);
    }
  });

  it('refuses a `?` wildcard entry handed an origin it would otherwise cover', async () => {
    // `https://?.example.com` is configured above; a request can never name `?` in its own origin,
    // so a `*` origin that the entry would glob must be refused, not resolved.
    const res = await probe({ origin: 'https://*.example.com', cookie: person.cookie }, { callbackURL: 'https://long.example.com/cb' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_ORIGIN');
  });

  it('lets a legitimate browser origin that a wildcard covers sign in and write with its cookie', async () => {
    const started = await signIn({ origin: 'https://app.example.com' });
    expect(started.status).toBe(200);
    const cookie = cookieOf(started);
    expect(cookie).toContain('session');
    const signedOut = await authPost('/api/auth/sign-out', 'https://app.example.com', cookie);
    expect(signedOut.status).toBe(200);
  });

  it('accepts a callback URL on another origin the same wildcard covers', async () => {
    const res = await signIn({ origin: 'https://app.example.com' }, { callbackURL: 'https://admin.example.com/after?x=1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redirect).toBe(true);
    expect(body.url).toBe('https://admin.example.com/after?x=1');
  });

  it('still refuses a callback URL no entry covers', async () => {
    const res = await probe({ origin: 'https://app.example.com' }, { callbackURL: 'https://evil.example.net/after' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_CALLBACK_URL');
  });

  it('accepts the app origin itself, and a Referer when Origin is absent', async () => {
    const started = await signIn({ origin: t.base });
    expect(started.status).toBe(200);
    const byReferer = await post('/api/auth/sign-out', { referer: `${t.base}/people`, cookie: cookieOf(started) }, {});
    expect(byReferer.status).toBe(200);
  });

  it('still refuses an origin no entry covers', async () => {
    const res = await authPost('/api/auth/sign-out', 'https://evil.example.net', person.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_ORIGIN');
  });
});
