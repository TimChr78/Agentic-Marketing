import http from 'node:http';
import { newId } from '@agentic-marketing/core';
import { linkSigner } from '@agentic-marketing/email';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #185/#188: public pages resolve by brand host, links stay on that brand, and a token from one
// workspace is refused on another workspace's host.

const MAIN_PORT = testPort(3450);
const PUBLIC_PORT = testPort(3451);
const FALLBACK = `http://localhost:${MAIN_PORT}`;
const SECRET = 'test-secret-test-secret-test-secret-123';
const signer = linkSigner(SECRET);

const A = 'a.example';
const B = 'b.example';
const SITE_A = 'https://site-a.example';
const SITE_B = 'https://site-b.example';

let t: Awaited<ReturnType<typeof startTestServer>>;
let ownerA: User;
let ownerB: User;
let wsA = '';
let wsB = '';
let domainA = '';
let domainB = '';
let formA = '';
let formB = '';
let formVersionA = 0;
let formVersionB = 0;
let assetPathA = '';
let profileA = '';
let providerA: { id: string; webhookUrl: string } | undefined;

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

const publish = async (api: ReturnType<typeof t.api>, artifactId: string) =>
  api.call('artifacts.requestPublish', { artifactId, note: 'brand routing test' });

async function addVerified(owner: User, ws: string, host: string, pathPrefix?: string) {
  const added = await t.api(owner, ws).call('workspace.domains.add', {
    host,
    ...(pathPrefix ? { pathPrefix } : {}),
    isPrimary: !pathPrefix,
  });
  // The public listener serves the challenge for a pending row; the command's fetch is replaced.
  const challenge = await request(MAIN_PORT, `${pathPrefix ?? ''}/.well-known/am-domain/${added.domain.verificationToken}`, {
    host,
  });
  expect(challenge.status).toBe(200);
  expect(challenge.body).toBe(added.domain.verificationToken);
  const verified = await t.api(owner, ws).call('workspace.domains.verify', { id: added.domain.id });
  expect(verified.domain.status).toBe('verified');
  return added.domain.id;
}

beforeAll(async () => {
  t = await startTestServer('test_brand_routing', MAIN_PORT, {
    PUBLIC_PORT: String(PUBLIC_PORT),
    PUBLIC_URL: `http://localhost:${MAIN_PORT}`,
    PUBLIC_LINKS_URL: FALLBACK,
  });
  ownerA = await t.signUp(`brand-a-${Date.now()}@example.com`);
  ownerB = await t.signUp(`brand-b-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[ownerA, 'owner']], 'none');
  wsB = await t.workspaceWith([[ownerB, 'owner']], 'none');

  t.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
  domainA = await addVerified(ownerA, wsA, A);
  domainB = await addVerified(ownerB, wsB, B);

  const form = async (owner: User, ws: string, site: string, name: string) => {
    const created = await t.api(owner, ws).call('artifacts.create', {
      type: 'form',
      name,
      content: {
        purposes: ['marketing_email'],
        doubleOptIn: false,
        consentText: 'Send me the newsletter.',
        successUrl: `${site}/thanks`,
        confirmedUrl: `${site}/welcome`,
        allowedOrigins: [site],
      },
    });
    await publish(t.api(owner, ws), created.artifactId);
    const got = await t.api(owner, ws).call('artifacts.get', { artifactId: created.artifactId });
    return { id: created.artifactId, version: got.publishedVersion as number };
  };
  const a = await form(ownerA, wsA, SITE_A, 'Brand A form');
  formA = a.id;
  formVersionA = a.version;
  const b = await form(ownerB, wsB, SITE_B, 'Brand B form');
  formB = b.id;
  formVersionB = b.version;

  const brand = async (owner: User, ws: string, site: string, name: string, slug: string) => {
    const created = await t.api(owner, ws).call('artifacts.create', {
      type: 'brand',
      name,
      content: {
        siteName: name,
        siteUrl: site,
        language: 'en',
        archive: { enabled: true, title: `${name} archive`, description: 'Issues', slug, subscribeUrl: `${site}/#signup` },
      },
    });
    await publish(t.api(owner, ws), created.artifactId);
  };
  await brand(ownerA, wsA, SITE_A, 'Brand A', 'signal-a');
  await brand(ownerB, wsB, SITE_B, 'Brand B', 'signal-b');

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=';
  const asset = await t.api(ownerA, wsA).call('assets.upload', {
    fileName: 'one.png',
    contentType: 'image/png',
    dataBase64: png,
  });
  assetPathA = new URL(asset.url).pathname;
  expect(asset.url.startsWith(`https://${A}/a/`)).toBe(true);

  profileA = newId('prf');
  await t.srv.db.withWorkspace(wsA, (tx) => tx.execute(sql`INSERT INTO profiles (workspace_id, id) VALUES (${wsA}, ${profileA})`));

  const created = await t.api(ownerA, wsA).call('emailProviders.create', {
    name: 'Brand A log',
    adapter: 'log',
    fromEmail: 'news@a.example',
    useFor: ['transactional'],
  });
  providerA = { id: created.id, webhookUrl: created.webhookUrl };
}, 120_000);

afterAll(() => t?.close());

describe('brand host routing', () => {
  it('serves each brand its own form, and refuses the other brand’s host', async () => {
    const body = new URLSearchParams({ email: `reader-a-${Date.now()}@example.com` }).toString();
    const own = await request(MAIN_PORT, `/f/${formA}`, {
      method: 'POST',
      host: A,
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE_A },
    });
    expect(own.status).toBe(303);
    expect(own.headers.location).toBe(`${SITE_A}/thanks`);

    const crossed = await request(MAIN_PORT, `/f/${formA}`, {
      method: 'POST',
      host: B,
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE_A },
    });
    expect(crossed.status).toBe(404);

    const unknown = await request(MAIN_PORT, `/f/${formA}`, {
      method: 'POST',
      host: 'unknown.example',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(unknown.status).toBe(404);

    const bBody = new URLSearchParams({ email: `reader-b-${Date.now()}@example.com` }).toString();
    const ownB = await request(MAIN_PORT, `/f/${formB}`, {
      method: 'POST',
      host: B,
      body: bBody,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE_B },
    });
    expect(ownB.status).toBe(303);
    expect(ownB.headers.location).toBe(`${SITE_B}/thanks`);
    expect(formVersionB).toBeGreaterThan(0);
  });

  it('serves confirm, unsubscribe and preference pages only on the owning host', async () => {
    const confirm = signer.sign({
      k: 'doi',
      w: wsA,
      f: formA,
      v: formVersionA,
      a: 'anon-brand-a',
      s: new Date().toISOString(),
      x: Date.now() + 86_400_000,
    });
    expect((await request(MAIN_PORT, `/f/confirm/${confirm}`, { host: A })).status).toBe(200);
    expect((await request(MAIN_PORT, `/f/confirm/${confirm}`, { host: B })).status).toBe(404);

    const unsubscribe = signer.sign({ w: wsA, p: profileA, u: 'marketing_email', m: newId('msg') });
    expect((await request(MAIN_PORT, `/u/${unsubscribe}`, { host: A })).status).toBe(200);
    expect((await request(MAIN_PORT, `/u/${unsubscribe}`, { host: B })).status).toBe(404);

    const preferences = await request(MAIN_PORT, `/u/p/${unsubscribe}`, { host: A });
    expect(preferences.status).toBe(200);
    expect(preferences.body).toContain('Brand A');
    const crossed = await request(MAIN_PORT, `/u/p/${unsubscribe}`, { host: B });
    expect(crossed.status).toBe(404);
    expect(crossed.body).not.toContain('Brand A');

    // The unsubscribe POST must not act when the host is another brand's.
    const crossedPost = await request(MAIN_PORT, `/u/${unsubscribe}`, { method: 'POST', host: B });
    expect(crossedPost.status).toBe(404);
  });

  it('serves assets only on their brand host, with the owning host in the URL', async () => {
    const own = await request(MAIN_PORT, assetPathA, { host: A });
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect((await request(MAIN_PORT, assetPathA, { host: B })).status).toBe(404);
    expect((await request(MAIN_PORT, assetPathA, { host: 'unknown.example' })).status).toBe(404);
  });

  it('resolves the archive by host then slug and builds RSS/sitemap URLs on the brand host', async () => {
    const page = await request(MAIN_PORT, '/n/signal-a/', { host: A });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Brand A archive');

    const feed = await request(MAIN_PORT, '/n/signal-a/feed.xml', { host: A });
    expect(feed.status).toBe(200);
    expect(feed.body).toContain(`https://${A}/n/signal-a/`);

    const sitemap = await request(MAIN_PORT, '/n/signal-a/sitemap.xml', { host: A });
    expect(sitemap.status).toBe(200);
    expect(sitemap.body).toContain(`https://${A}/n/signal-a/`);

    // B's host does not know A's slug, even though slugs are unique installation-wide today.
    expect((await request(MAIN_PORT, '/n/signal-a/', { host: B })).status).toBe(404);
    expect((await request(MAIN_PORT, '/n/signal-a/feed.xml', { host: B })).status).toBe(404);
  });

  it('404s an unknown host for every brand path', async () => {
    for (const path of [
      '/f/x',
      '/u/test',
      '/u/p/test',
      '/c/test',
      '/a/ast_00000000000000000000000000000000/x.png',
      '/n/x/',
      '/hooks/email/x/y',
    ]) {
      expect((await request(MAIN_PORT, path, { host: 'unknown.example' })).status, path).toBe(404);
    }
  });

  it('keeps the fallback host on today’s behaviour for a single-brand install', async () => {
    const unsubscribe = signer.sign({ w: wsA, p: profileA, u: 'marketing_email', m: newId('msg') });
    expect((await request(MAIN_PORT, `/u/${unsubscribe}`)).status).toBe(200);
    expect((await request(MAIN_PORT, `/f/${formA}`, { method: 'POST', body: '', headers: {} })).status).not.toBe(404);
    expect(await t.srv.domains.linksUrlFor(wsA)).toBe(`https://${A}`);
    // A workspace without a domain still links to PUBLIC_LINKS_URL.
    const c = await t.workspaceWith([[ownerA, 'owner']], 'none');
    expect(await t.srv.domains.linksUrlFor(c)).toBe(FALLBACK);
  });

  it('resolves a path prefix and keeps links under it', async () => {
    await addVerified(ownerB, wsB, 'prefixed.example', '/am');
    const page = await request(MAIN_PORT, '/am/n/signal-b/', { host: 'prefixed.example' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Brand B archive');
    const post = await request(MAIN_PORT, `/am/f/${formB}`, {
      method: 'POST',
      host: 'prefixed.example',
      body: new URLSearchParams({ email: `prefix-${Date.now()}@example.com` }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE_B },
    });
    expect(post.status).toBe(303);
    expect(post.headers.location).toBe(`${SITE_B}/thanks`);
    // Without the prefix the same host has no brand.
    expect((await request(MAIN_PORT, '/n/signal-b/', { host: 'prefixed.example' })).status).toBe(404);
    // The prefix never exposes admin routes.
    expect((await request(MAIN_PORT, '/am/v1/workspace.get', { host: 'prefixed.example' })).status).toBe(404);
    expect((await t.srv.domains.resolvePublicRequest('prefixed.example', '/am/u/x'))?.linksUrl).toBe('https://prefixed.example/am');
  });

  it('builds each workspace’s provider webhook URL on its own host', async () => {
    expect(providerA?.webhookUrl.startsWith(`https://${A}/hooks/email/`)).toBe(true);
    const created = await t.api(ownerB, wsB).call('emailProviders.create', {
      name: 'Brand B log',
      adapter: 'log',
      fromEmail: 'news@b.example',
      useFor: ['transactional'],
    });
    expect(created.webhookUrl.startsWith(`https://${B}/hooks/email/`)).toBe(true);

    // Move B to a new domain, verify it, then refresh: the returned URL uses the new host.
    await t.api(ownerB, wsB).call('workspace.domains.update', { id: domainB, host: 'b2.example' });
    await t.api(ownerB, wsB).call('workspace.domains.verify', { id: domainB });
    const refreshed = await t.api(ownerB, wsB).call('emailProviders.refreshWebhookUrl', { id: created.id });
    expect(refreshed.webhookUrl.startsWith('https://b2.example/hooks/email/')).toBe(true);
    expect(refreshed.webhookUrl).not.toBe(created.webhookUrl);
  });

  it('never redirects a click token to another brand', async () => {
    const click = signer.sign({ w: wsA, m: newId('msg'), url: `${SITE_A}/landing` });
    const own = await request(MAIN_PORT, `/c/${click}`, { host: A });
    expect(own.status).toBe(302);
    expect(own.headers.location).toBe(`${SITE_A}/landing`);
    expect((await request(MAIN_PORT, `/c/${click}`, { host: B })).status).toBe(404);
  });

  it('shows the brand link host in deliverability and provider checks', async () => {
    const provider = providerA!;
    const check = await t.api(ownerA, wsA).call('emailProviders.checkDomain', { id: provider.id });
    expect(check).toMatchObject({ linksUrl: `https://${A}`, linksHost: A });
    const health = await t.api(ownerA, wsA).call('deliverability.health', {});
    expect(health.brand).toMatchObject({ linksUrl: `https://${A}`, linksHost: A });
  });

  it('keeps verify people-only and admin-only', async () => {
    const notAdmin = await t.workspaceWith([[ownerA, 'marketer']], 'none');
    const error = await rejects(t.api(ownerA, notAdmin).call('workspace.domains.verify', { id: domainA }));
    expect(error.status).toBe(403);
  });
});
