import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HSTS_MAX_AGE, securityHeaders } from '../src/http/security-headers';
import { startTestServer, testPort, type User } from './harness';

// #178: baseline security headers on the admin UI, the API and health checks, without replacing
// the stricter policies that hosted pages set themselves.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), 'am-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Admin</title>');
  t = await startTestServer('test_security_headers', testPort(3479), { WEB_DIST: web });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(() => t?.close());

const baseline = (res: Response) => {
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
};

describe('security headers', () => {
  it('the admin UI shell cannot be framed', async () => {
    for (const path of ['/', '/approvals']) {
      const res = await fetch(`${t.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      baseline(res);
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
  });

  it('API responses and health checks carry the baseline', async () => {
    const api = await fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: '{}',
    });
    expect(api.status).toBe(200);
    baseline(api);
    expect(api.headers.get('content-security-policy')).toBeNull();
    baseline(await fetch(`${t.base}/healthz`));
  });

  it('a hosted page keeps its own stricter policy', async () => {
    const res = await fetch(`${t.base}/f/confirm/not-a-token`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('adds HSTS only behind an HTTPS public URL, and keeps one set upstream', async () => {
    const app = (https: boolean) => {
      const a = new Hono();
      a.use('*', securityHeaders({ https }));
      a.get('/', (c) => c.text('ok'));
      a.get('/own', (c) => c.text('ok', 200, { 'Strict-Transport-Security': 'max-age=60' }));
      return a;
    };
    expect((await app(false).request('/')).headers.get('strict-transport-security')).toBeNull();
    expect((await app(true).request('/')).headers.get('strict-transport-security')).toBe(`max-age=${HSTS_MAX_AGE}`);
    expect((await app(true).request('/own')).headers.get('strict-transport-security')).toBe('max-age=60');
  });
});
