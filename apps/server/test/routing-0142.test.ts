import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #608/#609/#610: a registered path prefix re-dispatches the request through the same app. The
// inner pass must keep the socket address (so the form limiter buckets by client, not by
// 'unknown'), must not be counted a second time (and the one count belongs to the stripped
// route), and unmatched /hooks and /scim API paths must answer JSON, never the admin SPA.

const MAIN_PORT = testPort(3360);
const METRICS_TOKEN = 'routing-0142-token-0123456789abcdef';
const PREFIXED_HOST = 'prefixed-0142.example';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId = '';
let formId = '';
let webRoot = '';

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

const request = (path: string, options: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: MAIN_PORT,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `localhost:${MAIN_PORT}`, ...(options.headers ?? {}) },
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

const submit = (path: string, host: string, ip: string) =>
  request(path, {
    method: 'POST',
    host,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: `routing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` }),
  });

const scrape = async () => {
  const res = await request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  expect(res.status).toBe(200);
  return res.body;
};

/** Sums `am_http_requests_total` by route group, and over every series. */
function totals(body: string) {
  const byRoute = new Map<string, number>();
  let all = 0;
  for (const match of body.matchAll(/^am_http_requests_total\{route="([^"]+)",status="[^"]+"\} (\d+)$/gm)) {
    const route = match[1];
    const value = Number(match[2]);
    byRoute.set(route, (byRoute.get(route) ?? 0) + value);
    all += value;
  }
  return { all, of: (route: string) => byRoute.get(route) ?? 0 };
}

beforeAll(async () => {
  // A real built UI, so the SPA fallback is active: that is what used to answer /hooks and /scim.
  webRoot = await mkdtemp(join(tmpdir(), 'am-routing-0142-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">routing SPA shell</div>');

  t = await startTestServer('test_routing_0142', MAIN_PORT, {
    METRICS_TOKEN,
    WEB_DIST: webRoot,
    PUBLIC_URL: `http://localhost:${MAIN_PORT}`,
    PUBLIC_LINKS_URL: `http://localhost:${MAIN_PORT}`,
    // The test client connects over loopback, so its forwarding header is trusted like a proxy's.
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  });
  owner = await t.signUp(`routing-0142-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']]);

  t.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
  const added = await t.api(owner, workspaceId).call('workspace.domains.add', {
    host: PREFIXED_HOST,
    pathPrefix: '/am',
  });
  const challenge = await request(`/am/.well-known/am-domain/${added.domain.verificationToken}`, { host: PREFIXED_HOST });
  expect(challenge.status).toBe(200);
  expect(challenge.body).toBe(added.domain.verificationToken);
  const verified = await t.api(owner, workspaceId).call('workspace.domains.verify', { id: added.domain.id });
  expect(verified.domain.status).toBe('verified');

  const created = await t.api(owner, workspaceId).call('artifacts.create', {
    type: 'form',
    name: 'Routing 0.14.2 form',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: 'https://prefixed-0142.example/thanks',
      confirmedUrl: 'https://prefixed-0142.example/welcome',
    },
  });
  await t.api(owner, workspaceId).call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'routing test' });
  formId = created.artifactId;
}, 120_000);

afterAll(async () => {
  await t?.close();
  if (webRoot) await rm(webRoot, { recursive: true, force: true });
});

describe('prefixed dispatch keeps the client identity (#608)', () => {
  it('shares one bucket between prefixed and unprefixed requests from the same forwarded client', async () => {
    const client = '203.0.113.10';
    // The default form budget is 5/minute with a burst of 15.
    for (let i = 0; i < 15; i++) expect((await submit(`/am/f/${formId}`, PREFIXED_HOST, client)).status, `prefixed ${i}`).toBe(200);
    expect((await submit(`/am/f/${formId}`, PREFIXED_HOST, client)).status).toBe(429);

    // The same client without the prefix must already be out of budget: one client, one bucket.
    const unprefixed = await submit(`/f/${formId}`, `localhost:${MAIN_PORT}`, client);
    expect(unprefixed.status).toBe(429);
  });

  it('gives different forwarded clients behind the trusted proxy separate buckets', async () => {
    const other = await submit(`/am/f/${formId}`, PREFIXED_HOST, '203.0.113.11');
    expect(other.status).toBe(200);
  });
});

describe('prefixed dispatch is counted once, under its real route (#609)', () => {
  it('increments exactly one request, in the public group, for a prefixed public path', async () => {
    const before = totals(await scrape());
    const res = await request(`/am/f/${formId}`, { host: PREFIXED_HOST });
    expect(res.status).toBe(404); // GET has no handler; the route class is what matters.
    const after = totals(await scrape());

    expect(after.all - before.all).toBe(1);
    expect(after.of('public') - before.of('public')).toBe(1);
    // The prefixed path (/am/f/…) used to be counted as admin UI traffic too.
    expect(after.of('ui') - before.of('ui')).toBe(0);
  });
});

describe('unmatched API paths are JSON, never the SPA (#610)', () => {
  it('answers a GET to a webhook URL with a JSON 404', async () => {
    const res = await request('/hooks/in/x/y');
    expect(res.status).toBe(404);
    expect(res.headers['content-type'] ?? '').toContain('application/json');
    expect(res.body).not.toContain('routing SPA shell');
    expect(JSON.parse(res.body)).toMatchObject({ error: 'not_found' });
  });

  it('answers an unmatched authenticated SCIM path with a JSON 404', async () => {
    const token = (await t.api(owner, workspaceId).call('scim.rotateToken', {})).token;
    const res = await request('/scim/v2/NotAResource', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    expect(res.headers['content-type'] ?? '').toContain('application/scim+json');
    expect(res.body).not.toContain('routing SPA shell');
    expect(JSON.parse(res.body)).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404' });

    // Real SCIM routes still win over the catch-all.
    const users = await request('/scim/v2/Users', { headers: { authorization: `Bearer ${token}` } });
    expect(users.status).toBe(200);
    expect(users.headers['content-type'] ?? '').toContain('application/scim+json');
  });
});
