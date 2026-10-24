import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from './harness';

// The optional public listener has no path rule: only /f, /u, /c, /hooks and the probes exist.
// Requests are sent with node:http because fetch and most clients normalise `..` before sending.

const MAIN_PORT = 3299;
const PUBLIC_PORT = 3300;
const SITE = 'https://public.example';
let t: Awaited<ReturnType<typeof startTestServer>>;
let formId = '';

const raw = (port: number, path: string, method = 'GET', body = '', headers: Record<string, string> = {}) =>
  new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

beforeAll(async () => {
  t = await startTestServer('test_public_listener', MAIN_PORT, { PUBLIC_PORT: String(PUBLIC_PORT) });
  const owner = await t.signUp(`public-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const created = await t.api(owner).call('artifacts.create', {
    type: 'form',
    name: 'Public listener form',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: `${SITE}/thanks`,
      confirmedUrl: `${SITE}/welcome`,
      allowedOrigins: [SITE],
    },
  });
  await t.api(owner).call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'public listener test' });
  formId = created.artifactId;
}, 60_000);
afterAll(() => t?.close());

describe('public listener', () => {
  it('rejects raw traversal instead of reaching the admin API', async () => {
    for (const path of ['/f/../v1/workspace.get', '/f/%2e%2e/v1/workspace.get', '/hooks/../mcp']) {
      const res = await raw(PUBLIC_PORT, path, 'POST');
      // 400 from the guard, or 404 if a proxy in front rejected it first: never the API's 401.
      expect([400, 404], path).toContain(res.status);
    }
  });

  it('404s the admin API, MCP and unknown prefixes', async () => {
    expect((await raw(PUBLIC_PORT, '/v1/workspace.get', 'POST')).status).toBe(404);
    expect((await raw(PUBLIC_PORT, '/mcp', 'POST')).status).toBe(404);
    expect((await raw(PUBLIC_PORT, '/', 'GET')).status).toBe(404);
    expect((await raw(PUBLIC_PORT, '/foo', 'GET')).status).toBe(404);
    expect((await raw(PUBLIC_PORT, '/foo/f/x', 'GET')).status).toBe(404);
  });

  it('still serves a real form and the probes', async () => {
    const body = new URLSearchParams({ email: `reader-${Date.now()}@example.com` }).toString();
    const post = await raw(PUBLIC_PORT, `/f/${formId}`, 'POST', body, {
      'content-type': 'application/x-www-form-urlencoded',
      origin: SITE,
    });
    expect(post.status).toBe(303);
    expect(post.location).toBe(`${SITE}/thanks`);
    expect((await raw(PUBLIC_PORT, '/healthz', 'GET')).status).toBe(200);
  });

  it('rejects raw traversal on the main listener too', async () => {
    expect((await raw(MAIN_PORT, '/f/../v1/workspace.get', 'POST')).status).toBe(400);
    expect((await raw(MAIN_PORT, '/f/%2e%2e/v1/workspace.get', 'POST')).status).toBe(400);
    // Normal admin access keeps working.
    expect((await raw(MAIN_PORT, '/v1/workspace.get', 'POST')).status).toBe(401);
  });
});
