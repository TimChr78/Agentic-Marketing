import { createECDH, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
// @ts-expect-error http_ece ships no types; it decrypts like a browser would.
import ece from 'http_ece';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 11 (wave 2), part d: push. Browsers subscribe with the workspace's VAPID key (web push,
// encrypted per RFC 8291), apps register FCM and APNs tokens; one message reaches every device of
// a person with consent, gone devices are forgotten, and erasure removes them all. The push
// services here are local fakes: web push and FCM over HTTP, APNs over HTTP/2.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let browserKey = '';
let serverKey = '';
let fake: Server;
let apns: Http2Server;
let base = '';
let apnsBase = '';
const webPushes: { path: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
const fcmSends: { auth: string; body: { message: { token: string; notification: { title: string } } } }[] = [];
const apnsSends: { path: string; headers: Record<string, unknown>; body: { aps: { alert: { title: string } } } }[] = [];
const ua = createECDH('prime256v1');
ua.generateKeys();
const auth = Buffer.from('fedcba9876543210');
const ORIGIN = 'https://shop.example.com';

const post = (path: string, key: string, body: unknown) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify(body),
  });
const subscription = (path: string) => ({
  endpoint: `${base}${path}`,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
});

beforeAll(async () => {
  fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (req.url === '/token')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
    if (req.url?.startsWith('/v1/projects/')) {
      const b = JSON.parse(body.toString());
      fcmSends.push({ auth: String(req.headers.authorization), body: b });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'projects/shop-app/messages/1' }));
    }
    webPushes.push({ path: req.url ?? '', headers: req.headers, body });
    res.writeHead(req.url === '/push/gone' ? 410 : 201, { location: `${base}/msg/${webPushes.length}` }).end();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  apns = createHttp2Server();
  apns.on('stream', (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      apnsSends.push({ path: String(headers[':path']), headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      stream.respond({ ':status': 200, 'apns-id': 'apns-1' });
      stream.end();
    });
  });
  await new Promise<void>((r) => apns.listen(0, '127.0.0.1', r));
  apnsBase = `http://127.0.0.1:${(apns.address() as AddressInfo).port}`;

  t = await startTestServer('test_p11_push', testPort(3295));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  browserKey = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [ORIGIN] })).key;
  serverKey = (await api.call('sources.create', { name: 'App backend', kind: 'server' })).key;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  await api.call('pushProviders.create', {
    name: 'Browsers',
    adapter: 'webpush',
    config: { subject: 'mailto:ops@example.com' },
    useFor: ['marketing', 'transactional'],
  });
  await api.call('pushProviders.create', {
    name: 'Android',
    adapter: 'fcm',
    config: { projectId: 'shop-app', apiBase: base, tokenUrl: `${base}/token` },
    secrets: { clientEmail: 'push@shop-app.iam.gserviceaccount.com', privateKey: rsa },
    useFor: ['marketing', 'transactional'],
  });
  await api.call('pushProviders.create', {
    name: 'iOS',
    adapter: 'apns',
    config: { teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'com.example.shop', apiBase: apnsBase },
    secrets: { privateKey: p8 },
    useFor: ['marketing', 'transactional'],
  });
  // No quiet hours, so the results do not depend on the time of day.
  const pol = await api.call('artifacts.create', { type: 'delivery_policy', name: 'Policy', content: { quietHours: [] } });
  await api.call('artifacts.requestPublish', { artifactId: pol.artifactId, note: 'x' });
}, 60_000);
afterAll(async () => {
  await t?.close();
  fake?.close();
  apns?.close();
});

async function person(userId: string, anonymousId: string, consent: boolean) {
  const api = t.api(owner);
  await post('/v1/batch', browserKey, {
    batch: [
      {
        type: 'identify',
        userId,
        anonymousId,
        traits: { firstName: 'Ada' },
        context: { consent: { categoryPreferences: { analytics: true } } },
      },
      {
        type: 'track',
        event: 'Segment Consent Preference Updated',
        userId,
        anonymousId,
        context: { consent: { categoryPreferences: { analytics: true, marketing_push: consent } } },
      },
    ],
  });
  const { profileId } = await eventually(
    () => api.call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api.call('consent.history', { profileId: profileId! }),
    (s) => s.records.some((r) => r.purpose === 'marketing_push'),
  );
  return profileId!;
}

let template = '';
let ada = '';

describe('registration', () => {
  it('gives browsers the VAPID key and keeps devices sealed', async () => {
    const cfg = await fetch(`${t.base}/v1/push/config?writeKey=${browserKey}`, { headers: { origin: ORIGIN } });
    const { webPush } = (await cfg.json()) as { webPush: { publicKey: string } };
    expect(webPush.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(
      (await fetch(`${t.base}/v1/push/config?writeKey=${browserKey}`, { headers: { origin: 'https://evil.example.com' } })).status,
    ).toBe(403);

    ada = await person('u-ada', 'anon-ada', true);
    expect((await post('/v1/push/subscribe', browserKey, { anonymousId: 'anon-ada', subscription: subscription('/push/1') })).status).toBe(
      200,
    );
    expect(
      (await post('/v1/push/subscribe', browserKey, { anonymousId: 'anon-ada', subscription: subscription('/push/gone') })).status,
    ).toBe(200);
    expect((await post('/v1/push/subscribe', serverKey, { userId: 'u-ada', kind: 'fcm', token: 'fcm-token-0123456789' })).status).toBe(200);
    expect((await post('/v1/push/subscribe', serverKey, { userId: 'u-ada', kind: 'apns', token: 'a'.repeat(64) })).status).toBe(200);
    // Registering the same device again does not add one.
    expect((await post('/v1/push/subscribe', browserKey, { anonymousId: 'anon-ada', subscription: subscription('/push/1') })).status).toBe(
      200,
    );
    expect((await post('/v1/push/subscribe', browserKey, { subscription: subscription('/push/x') })).status).toBe(400);
    // A browser key cannot bind a device to someone's user id.
    expect((await post('/v1/push/subscribe', browserKey, { userId: 'u-ada', subscription: subscription('/push/x') })).status).toBe(400);

    const { devices } = await t.api(owner).call('push.devices', { profileId: ada });
    expect(devices.map((d) => d.kind).sort()).toEqual(['apns', 'fcm', 'web', 'web']);
    expect(JSON.stringify(devices)).not.toContain('push/1');
  });
});

describe('sending', () => {
  it('previews a template', async () => {
    const api = t.api(owner);
    const a = await api.call('artifacts.create', {
      type: 'push_template',
      name: 'Sale',
      content: {
        purpose: 'marketing_push',
        title: '{{ profile.firstName }}, the sale is on',
        body: 'Tents 20% off until Sunday.',
        url: 'https://shop.example.com/sale',
        sampleData: { profile: { firstName: 'Ada' } },
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
    template = a.artifactId;
    expect(await api.call('pushTemplates.preview', { artifactId: template })).toMatchObject({
      title: 'Ada, the sale is on',
      body: 'Tents 20% off until Sunday.',
      url: 'https://shop.example.com/sale',
      warnings: [],
    });
  });

  it('notifies every device: web push encrypted with VAPID, FCM and APNs', async () => {
    const api = t.api(owner);
    const d = await api.call('messages.sendPush', { profileId: ada, templateId: template });
    expect(d.status).toBe('queued');
    await eventually(
      async () => (await api.call('messages.list', { profileId: ada, limit: 10 })).messages.find((m) => m.id === d.messageId),
      (m) => m?.status === 'sent',
      15_000,
    );
    const web = webPushes.find((w) => w.path === '/push/1')!;
    expect(web.headers['content-encoding']).toBe('aes128gcm');
    expect(String(web.headers.authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
    const payload = JSON.parse(ece.decrypt(web.body, { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString());
    expect(payload).toMatchObject({ title: 'Ada, the sale is on', body: 'Tents 20% off until Sunday.', messageId: d.messageId });
    // The link is the tracked redirect, which leads to the page.
    expect(payload.url).toMatch(/\/c\//);
    const click = await fetch(payload.url, { redirect: 'manual' });
    expect(click.headers.get('location')).toBe('https://shop.example.com/sale');

    expect(fcmSends.at(-1)).toMatchObject({
      auth: 'Bearer ya29.test',
      body: { message: { token: 'fcm-token-0123456789', notification: { title: 'Ada, the sale is on' } } },
    });
    expect(apnsSends.at(-1)).toMatchObject({
      path: `/3/device/${'a'.repeat(64)}`,
      headers: { 'apns-topic': 'com.example.shop', 'apns-push-type': 'alert' },
      body: { aps: { alert: { title: 'Ada, the sale is on' } } },
    });
    expect(String(apnsSends.at(-1)?.headers.authorization)).toMatch(/^bearer /);

    // The browser that unsubscribed (410) is forgotten.
    const { devices } = await api.call('push.devices', { profileId: ada });
    expect(devices.map((x) => x.kind).sort()).toEqual(['apns', 'fcm', 'web']);
  });

  it('does not notify without consent, or without devices', async () => {
    const api = t.api(owner);
    const bo = await person('u-bo', 'anon-bo', false);
    await post('/v1/push/subscribe', browserKey, { anonymousId: 'anon-bo', subscription: subscription('/push/bo') });
    expect(await api.call('messages.sendPush', { profileId: bo, templateId: template })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('no_lawful_basis'),
    });
    const cy = await person('u-cy', 'anon-cy', true);
    expect(await api.call('messages.sendPush', { profileId: cy, templateId: template })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('no_address'),
    });
  });

  it('forgets devices on unsubscribe and on erasure', async () => {
    const api = t.api(owner);
    expect((await post('/v1/push/unsubscribe', browserKey, { endpoint: `${base}/push/1` })).status).toBe(200);
    expect((await api.call('push.devices', { profileId: ada })).devices.map((x) => x.kind).sort()).toEqual(['apns', 'fcm']);
    const exported = await api.call('profiles.export', { profileId: ada, maxEvents: 0 });
    expect(exported.pushDevices).toHaveLength(2);
    await api.call('profiles.erase', { profileId: ada, reason: 'Erasure request (test)' });
    const left = await t.srv.db.admin.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', ['u-ada']);
    expect(left.rows[0].n).toBe(0);
  });

  it('keeps VAPID keys fixed and credentials write-only', async () => {
    const api = t.api(owner);
    const { providers } = await api.call('pushProviders.list', {});
    expect(JSON.stringify(providers)).not.toContain('PRIVATE KEY');
    const web = providers.find((p) => p.adapter === 'webpush')!;
    expect(web.hasCredentials).toBe(true);
    expect((await rejects(api.call('pushProviders.update', { id: web.id, secrets: { privateKey: 'x'.repeat(43) } }))).message).toContain(
      'cannot change',
    );
  });
});
