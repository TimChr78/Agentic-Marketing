import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1279: with Host checking active, only the admin host (PUBLIC_URL) serves the admin and API
// surface: the UI, auth, MCP, SCIM and admin REST. Any other Host that is neither a verified brand
// domain nor the fallback links host gets 404, so a name that resolves to this installation cannot
// reach the admin routes. Health probes answer on every Host (Kubernetes sends the pod IP, Docker
// and Compose send 127.0.0.1), and the metrics scrape on every non-brand Host: the pod IP or
// Service name Prometheus uses and the fallback links host.

const PORT = testPort(4700);
const PUBLIC_PORT = testPort(4710);
const ADMIN_HOST = `localhost:${PORT}`;
const BRAND = 'brand-1279.example';
const UNKNOWN = 'unregistered-1279.example';
const LINKS = 'links-1279.example';
// What a Kubernetes probe or a Prometheus scrape sends instead of PUBLIC_URL's host.
const POD = '10.244.1.7:3000';
const METRICS_TOKEN = 'metrics-token-1279';

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

const request = (
  path: string,
  options: { method?: string; host?: string; body?: string; headers?: Record<string, string>; port?: number } = {},
) =>
  new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port ?? PORT,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? ADMIN_HOST, ...(options.headers ?? {}) },
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

const mcp = (host?: string) =>
  request('/mcp', {
    method: 'POST',
    host,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId = '';
let webDist = '';

beforeAll(async () => {
  // A built admin UI, so the SPA mount is real: the UI is part of the surface the host gate keeps.
  webDist = mkdtempSync(join(tmpdir(), 'am-admin-host-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>admin shell</body></html>');
  t = await startTestServer('test_admin_host_1279', PORT, {
    WEB_DIST: webDist,
    METRICS_TOKEN,
    PUBLIC_URL: `http://localhost:${PORT}`,
    PUBLIC_LINKS_URL: `https://${LINKS}`,
  });
  owner = await t.signUp(`admin-host-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']], 'none');

  // Verify one brand domain: that switches Host checking on for the installation.
  t.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
  const added = await t.api(owner, workspaceId).call('workspace.domains.add', { host: BRAND, isPrimary: true });
  const challenge = await request(`/.well-known/am-domain/${added.domain.verificationToken}`, { host: BRAND });
  expect(challenge.status).toBe(200);
  const verified = await t.api(owner, workspaceId).call('workspace.domains.verify', { id: added.domain.id });
  expect(verified.domain.status).toBe('verified');
}, 120_000);

afterAll(async () => {
  await t?.close();
  rmSync(webDist, { recursive: true, force: true });
});

const restCall = (host?: string) =>
  request('/v1/workspace.get', {
    method: 'POST',
    host,
    body: '{}',
    headers: {
      'content-type': 'application/json',
      cookie: owner.cookie,
      origin: `http://localhost:${PORT}`,
      'x-workspace-id': workspaceId,
    },
  });

describe('the admin surface is PUBLIC_URL’s host alone (#1279)', () => {
  it('serves the UI, auth, MCP and REST on the admin host', async () => {
    const ui = await request('/', { host: ADMIN_HOST });
    expect(ui.status).toBe(200);
    expect(ui.body).toContain('admin shell');
    expect((await request('/openapi.json', { host: ADMIN_HOST })).status).toBe(200);
    expect((await request('/login', { host: ADMIN_HOST })).status).toBe(200);
    expect((await request('/api/auth/get-session', { host: ADMIN_HOST })).status).toBe(200);

    const rest = await restCall(ADMIN_HOST);
    expect(rest.status).toBe(200);
    expect(JSON.parse(rest.body)).toMatchObject({ id: workspaceId });

    // A mounted MCP endpoint refuses the missing credentials; an unmounted path is a bare 404.
    expect((await mcp(ADMIN_HOST)).status).toBe(401);
  });

  it('404s an unregistered Host on the UI, auth, MCP and REST', async () => {
    for (const path of ['/', '/login', '/openapi.json', '/api/auth/get-session', '/scim/v2/Users']) {
      const res = await request(path, { host: UNKNOWN });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toMatchObject({ error: 'not_found', message: 'Not found.' });
      expect(res.body, path).not.toContain('admin shell');
    }
    expect((await mcp(UNKNOWN)).status).toBe(404);
    // Even a valid session cookie and workspace header do not reach a command on that Host.
    expect((await restCall(UNKNOWN)).status).toBe(404);
  });

  it('treats 127.0.0.1 as the admin host when PUBLIC_URL is loopback', async () => {
    // A development install configured on localhost is reached as localhost, 127.0.0.1 or ::1.
    const loopback = await request('/', { host: '127.0.0.1' });
    expect(loopback.status).toBe(200);
    expect(loopback.body).toContain('admin shell');
  });

  it('serves a verified brand host its public surface only', async () => {
    expect((await request('/', { host: BRAND })).status).toBe(404);
    expect((await request('/openapi.json', { host: BRAND })).status).toBe(404);
    expect((await mcp(BRAND)).status).toBe(404);
    expect((await restCall(BRAND)).status).toBe(404);
    // The public API is part of the brand surface: an unknown write key is the gateway's answer.
    const tracking = await request('/v1/batch', {
      method: 'POST',
      host: BRAND,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(tracking.status).toBe(401);
    expect(JSON.parse(tracking.body)).toMatchObject({ error: 'invalid_write_key' });
  });

  it('keeps the fallback links host public once Host checking is active', async () => {
    expect((await request('/openapi.json', { host: LINKS })).status).toBe(404);
    expect((await request('/api/auth/get-session', { host: LINKS })).status).toBe(404);
    expect((await restCall(LINKS)).status).toBe(404);
  });

  it('answers the health probes on any Host and the metrics scrape on the pod IP', async () => {
    for (const host of [UNKNOWN, POD, LINKS, BRAND, ADMIN_HOST]) {
      const health = await request('/healthz', { host });
      expect(health.status, host).toBe(200);
      expect(JSON.parse(health.body), host).toMatchObject({ ok: true });
    }
    expect((await request('/readyz', { host: UNKNOWN })).status).toBe(200);
    // Prometheus scrapes the Service or the pod IP, never PUBLIC_URL's host: the route must be
    // mounted there, so its own 401 answers, not the host gate's 404.
    const anonymous = await request('/metrics', { host: POD });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toMatchObject({ error: 'unauthorized' });
    const scrape = await request('/metrics', { host: POD, headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(scrape.status).toBe(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
  });

  it('keeps the metrics scrape reachable on the fallback links host', async () => {
    // The fallback host is public, so the admin gate must not hide /metrics there either: the
    // token is the guard, and a resolver may send the scrape through the links name.
    const anonymous = await request('/metrics', { host: LINKS });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toMatchObject({ error: 'unauthorized' });
    const scrape = await request('/metrics', { host: LINKS, headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(scrape.status).toBe(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
  });
});

describe('a loopback Host is not the admin host when PUBLIC_URL is a public name (#1279)', () => {
  const NON_LOOPBACK_ADMIN = 'real-1279.example';
  let publicServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
  let publicWebDist = '';

  beforeAll(async () => {
    publicWebDist = mkdtempSync(join(tmpdir(), 'am-admin-host-public-'));
    writeFileSync(join(publicWebDist, 'index.html'), '<!doctype html><html><body>admin shell</body></html>');
    publicServer = await startTestServer('test_admin_host_1279_public', PUBLIC_PORT, {
      WEB_DIST: publicWebDist,
      METRICS_TOKEN,
      PUBLIC_URL: `https://${NON_LOOPBACK_ADMIN}`,
      PUBLIC_LINKS_URL: `https://${LINKS}`,
    });
    // Checking is installation policy and stays on once it has been switched on (#463); activate it
    // directly so the test needs no domain verification.
    await publicServer.srv.domains.activateHostChecking();
  }, 120_000);

  afterAll(async () => {
    await publicServer?.close();
    rmSync(publicWebDist, { recursive: true, force: true });
  }, 120_000);

  it('404s a loopback Host on an admin route once checking is active', async () => {
    const loopback = await request('/', { host: '127.0.0.1', port: PUBLIC_PORT });
    expect(loopback.status).toBe(404);
    expect(JSON.parse(loopback.body)).toMatchObject({ error: 'not_found', message: 'Not found.' });
    // The configured admin host still serves the UI, so the 404 is the host gate, not a missing build.
    const admin = await request('/', { host: NON_LOOPBACK_ADMIN, port: PUBLIC_PORT });
    expect(admin.status).toBe(200);
    expect(admin.body).toContain('admin shell');
  });
});
