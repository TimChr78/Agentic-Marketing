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

// A four-wildcard entry is the most an operator may configure (the release notes suggest
// `https://192.168.*.*:*` for a LAN), and the most expensive to match. The shape in the report,
// `https://*.*.*.*:*`, counts five wildcards and is already refused at start-up by the cap.
const WILDCARDS = 'https://*.*.*:*';
const LEGITIMATE = 'https://*.example.com';

let t: Awaited<ReturnType<typeof startServer>>;
let person: User;

const authPost = (path: string, origin: string | null, cookie?: string, referer?: string) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
      ...(referer === undefined ? {} : { referer }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: '{}',
  });

beforeAll(async () => {
  t = await startTestServer('auth_origin', testPort(2504), { TRUSTED_ORIGINS: `${WILDCARDS},${LEGITIMATE}` });
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
    expect(elapsed).toBeLessThan(100);
  });

  it('answers an 8 KB dot-heavy Referer immediately when there is no Origin', async () => {
    const referer = `https://${'.'.repeat(8 * 1024)}x/callback`;
    const started = performance.now();
    const res = await fetch(`${t.base}/api/auth/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer, cookie: person.cookie },
      body: '{}',
    });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.stringContaining('longer than 2048') });
    expect(elapsed).toBeLessThan(100);
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
    expect(elapsed).toBeLessThan(100);
  });

  it('lets a legitimate browser origin that a wildcard covers sign in and write with its cookie', async () => {
    const signIn = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
      body: JSON.stringify({ email: person.email, password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    expect(cookie).toContain('session');
    const signedOut = await authPost('/api/auth/sign-out', 'https://app.example.com', cookie);
    expect(signedOut.status).toBe(200);
  });

  it('accepts the app origin itself, and a Referer when Origin is absent', async () => {
    const signIn = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: person.email, password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    const byReferer = await fetch(`${t.base}/api/auth/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: `${t.base}/people`, cookie: cookieOf(signIn) },
      body: '{}',
    });
    expect(byReferer.status).toBe(200);
  });

  it('still refuses an origin no entry covers', async () => {
    const res = await authPost('/api/auth/sign-out', 'https://evil.example.net', person.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_ORIGIN');
  });
});
