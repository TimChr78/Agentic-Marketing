import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1157: split api/ingest roles. The Ingress sends the public paths to ingest and everything else
// to api, but a brand domain's registered path prefix (/am) reaches api, so api must mount the
// public routers too. Admin REST belongs to api only; an ingest pod must not serve it.

const API_PORT = testPort(3460);
const INGEST_PORT = testPort(3462);
const PREFIXED = 'prefixed-split.example';
const PENDING = 'pending-split.example';
const SITE = 'https://prefixed-split.example';

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

const request = (
  port: number,
  path: string,
  options: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {},
) =>
  new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `localhost:${port}`, ...(options.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });

let api: Awaited<ReturnType<typeof startTestServer>>;
let ingest: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId = '';
let formId = '';
let webDist = '';

beforeAll(async () => {
  // A built admin UI, so the SPA mount is real: both pods read WEB_DIST, but only api serves it.
  webDist = mkdtempSync(join(tmpdir(), 'am-split-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>admin</body></html>');
  api = await startTestServer('test_brand_split_api', API_PORT, {
    ROLE: 'api',
    WEB_DIST: webDist,
    PUBLIC_URL: `http://localhost:${API_PORT}`,
    PUBLIC_LINKS_URL: `http://localhost:${API_PORT}`,
  });
  ingest = await startTestServer('test_brand_split_ingest', INGEST_PORT, {
    ROLE: 'ingest',
    WEB_DIST: webDist,
    PUBLIC_URL: `http://localhost:${INGEST_PORT}`,
    PUBLIC_LINKS_URL: `http://localhost:${INGEST_PORT}`,
  });

  owner = await api.signUp(`brand-split-${Date.now()}@example.com`);
  workspaceId = await api.workspaceWith([[owner, 'owner']], 'none');

  api.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
  const added = await api.api(owner, workspaceId).call('workspace.domains.add', { host: PREFIXED, pathPrefix: '/am' });
  const challenge = await request(API_PORT, `/am/.well-known/am-domain/${added.domain.verificationToken}`, { host: PREFIXED });
  expect(challenge.status).toBe(200);
  const verified = await api.api(owner, workspaceId).call('workspace.domains.verify', { id: added.domain.id });
  expect(verified.domain.status).toBe('verified');

  const created = await api.api(owner, workspaceId).call('artifacts.create', {
    type: 'form',
    name: 'Split-role form',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: `${SITE}/thanks`,
      confirmedUrl: `${SITE}/welcome`,
      allowedOrigins: [SITE],
    },
  });
  await api.api(owner, workspaceId).call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'split role test' });
  formId = created.artifactId;
}, 120_000);

afterAll(async () => {
  await api?.close();
  await ingest?.close();
  rmSync(webDist, { recursive: true, force: true });
});

describe('path-prefixed brand routes on an api-only role (#1157)', () => {
  it('serves a form post under the registered prefix', async () => {
    const res = await request(API_PORT, `/am/f/${formId}`, {
      method: 'POST',
      host: PREFIXED,
      body: new URLSearchParams({ email: `split-${Date.now()}@example.com` }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${SITE}/thanks`);
  });

  it('serves the public /v1 routes under the prefix, not admin REST', async () => {
    const batch = await request(API_PORT, '/am/v1/batch', {
      method: 'POST',
      host: PREFIXED,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(batch.status).toBe(401);
    expect(JSON.parse(batch.body)).toMatchObject({ error: 'invalid_write_key' });

    const purposes = await request(API_PORT, '/am/v1/consent/purposes?writeKey=unknown', { host: PREFIXED });
    expect(purposes.status).toBe(401);

    const decide = await request(API_PORT, '/am/v1/decide', {
      method: 'POST',
      host: PREFIXED,
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(decide.status).toBe(400);
    expect(JSON.parse(decide.body)).toMatchObject({ error: 'invalid_json' });

    const push = await request(API_PORT, '/am/v1/push/subscribe', {
      method: 'POST',
      host: PREFIXED,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect([400, 401]).toContain(push.status);

    // Admin REST is never a brand path, with or without the prefix.
    for (const path of ['/am/v1/workspace.get', '/v1/workspace.get']) {
      const res = await request(API_PORT, path, {
        method: 'POST',
        host: PREFIXED,
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toMatchObject({ error: 'not_found', message: 'Not found.' });
    }
  });

  it('reaches the inbound webhook route under the prefix', async () => {
    const res = await request(API_PORT, '/am/hooks/in/conn_missing/token', {
      method: 'POST',
      host: PREFIXED,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    // The inbound handler answers its own 404; a missing mount would answer "Not found.".
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'not_found', message: 'Unknown or disabled webhook URL.' });
  });

  it('keeps admin REST on the api role', async () => {
    const call = await api.api(owner, workspaceId).call('workspace.get', {});
    expect(call.id).toBe(workspaceId);
    expect((await request(API_PORT, '/openapi.json')).status).toBe(200);
  });

  it('serves only the public surface on a registered, not-yet-verified host (#1231)', async () => {
    const client = api.api(owner, workspaceId);
    const added = await client.call('workspace.domains.add', { host: PENDING });
    expect(added.domain.status).toBe('pending');
    // The challenge still reaches the app, and the host is now registered.
    expect((await request(API_PORT, `/.well-known/am-domain/${added.domain.verificationToken}`, { host: PENDING })).status).toBe(200);

    // A public path works, as on the verified host.
    const batch = await request(API_PORT, '/v1/batch', {
      method: 'POST',
      host: PENDING,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(batch.status).toBe(401);
    expect(JSON.parse(batch.body)).toMatchObject({ error: 'invalid_write_key' });

    // Nothing of the admin surface does: not the UI's OpenAPI document, REST, auth, pages, MCP,
    // SCIM or OAuth discovery.
    for (const path of [
      '/openapi.json',
      '/api/auth/get-session',
      '/login',
      '/mcp',
      '/scim/v2/Users',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await request(API_PORT, path, {
        host: PENDING,
        ...(path === '/mcp'
          ? {
              method: 'POST',
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
              headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            }
          : {}),
      });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toMatchObject({ error: 'not_found' });
    }
    const rest = await request(API_PORT, '/v1/workspace.get', {
      method: 'POST',
      host: PENDING,
      body: '{}',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: api.base, 'x-workspace-id': workspaceId },
    });
    expect(rest.status).toBe(404);
  });
});

describe('admin REST is api-only (#1157)', () => {
  it('serves the admin UI only on the api role, never on an ingest pod (#1230)', async () => {
    // The same WEB_DIST is mounted on both pods; the shell belongs to the admin role alone.
    const onApi = await request(API_PORT, '/');
    expect(onApi.status).toBe(200);
    expect(onApi.body).toContain('admin');
    expect((await request(INGEST_PORT, '/')).status).toBe(404);
  });

  it('does not mount the command surface on an ingest pod', async () => {
    const rest = await request(INGEST_PORT, '/v1/workspace.get', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(rest.status).toBe(404);
    expect((await request(INGEST_PORT, '/openapi.json')).status).toBe(404);
  });

  it('does not mount MCP, auth or the server-rendered pages on an ingest pod (#1230)', async () => {
    const mcp = await request(INGEST_PORT, '/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    });
    // A mounted MCP endpoint answers 401 without credentials; an unmounted one answers 404.
    expect(mcp.status).toBe(404);
    for (const path of [
      '/api/auth/get-session',
      '/api/auth/sign-up/email',
      '/login',
      '/consent',
      '/invite',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      expect((await request(INGEST_PORT, path)).status, path).toBe(404);
    }
  });

  it('still serves the public paths on an ingest pod', async () => {
    const batch = await request(INGEST_PORT, '/v1/batch', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(batch.status).toBe(401);
  });
});
