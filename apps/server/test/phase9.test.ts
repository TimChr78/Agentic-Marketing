import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256 } from '@agentic-marketing/ads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 9 (wave 2), part 1: conversions to Meta (Conversions API) and Google (Data Manager API)
// for people who allowed ad_measurement, from a published conversion map, with test modes and a
// record per person. A local server stands in for both platforms and Google's OAuth.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let browserKey = '';
const SITE = 'https://shop.example.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ids = { meta: '', google: '', map: '' };

const received: { path: string; body: any; auth?: string }[] = [];
let platformUrl = '';
const platforms = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.url === '/token') return json(200, { access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 });
    received.push({ path: req.url ?? '', body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
    if (req.url?.endsWith('/events')) return json(200, { events_received: 1, fbtrace_id: 'trace-1' });
    if (req.url === '/v1/events:ingest')
      return req.headers.authorization === 'Bearer g-access'
        ? json(200, { requestId: 'req-1' })
        : json(401, { error: { message: 'unauthenticated' } });
    json(404, {});
  });
});
const at = (path: string) => received.filter((r) => r.path === path);

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: SITE,
      'user-agent': UA,
      authorization: `Basic ${Buffer.from(`${browserKey}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });
const prefs = (c: Record<string, boolean>) => ({ consent: { categoryPreferences: { analytics: true, ...c } }, userAgent: UA });

beforeAll(async () => {
  await new Promise<void>((r) => platforms.listen(0, '127.0.0.1', r));
  platformUrl = `http://127.0.0.1:${(platforms.address() as AddressInfo).port}`;
  t = await startTestServer('test_p9', 3289);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner);
  browserKey = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [SITE] })).key;
  ids.meta = (
    await api.call('connections.create', {
      connector: 'meta_ads',
      name: 'Meta',
      settings: { pixelId: '123456789', apiBase: platformUrl, testEventCode: 'TEST123' },
      secrets: { accessToken: 'meta-system-user-token-0123456789' },
    })
  ).id;
  ids.google = (
    await api.call('connections.create', {
      connector: 'google_ads',
      name: 'Google Ads',
      settings: {
        customerId: '1234567890',
        apiBase: platformUrl,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'gc-1', clientSecret: 'gs-1' },
    })
  ).id;
  const { url } = await api.call('connections.authorize', { id: ids.google });
  const back = await fetch(`${t.base}/oauth/callback?code=c1&state=${new URL(url).searchParams.get('state')}`);
  expect(back.status).toBe(200);
}, 60_000);
afterAll(async () => {
  await t?.close();
  platforms.close();
});

describe('conversion map', () => {
  it('refuses rules that point at the wrong kind of connection', async () => {
    const api = t.api(owner);
    const bad = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Conversions',
      content: { rules: [{ event: 'Order Completed', meta: { connection: ids.google, eventName: 'Purchase' } }] },
    });
    ids.map = bad.artifactId;
    expect((await rejects(api.call('artifacts.requestPublish', { artifactId: ids.map, note: 'x' }))).message).toContain(
      'is a google_ads connection',
    );
    await api.call('artifacts.updateDraft', {
      artifactId: ids.map,
      content: {
        rules: [
          { event: 'Order Completed', value: 'total', currency: 'DKK', meta: { connection: ids.meta, eventName: 'Purchase' } },
          {
            event: 'Subscription Confirmed',
            meta: { connection: ids.meta, eventName: 'Lead' },
            google: { connection: ids.google, conversionAction: '987654' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: ids.map, note: 'Purchases and leads' });
  });
});

describe('sending conversions', () => {
  it('sends a purchase to Meta with hashed identifiers, fbc and the event id', async () => {
    await ingest([
      {
        type: 'page',
        anonymousId: 'anon-ada',
        context: { ...prefs({ ad_measurement: true }), page: { url: `${SITE}/?fbclid=IwAR0abc&gclid=Cj0KCQada`, path: '/' } },
      },
      {
        type: 'identify',
        anonymousId: 'anon-ada',
        traits: { email: 'Ada@Example.com', phone: '+4512345678' },
        context: prefs({ ad_measurement: true }),
      },
    ]);
    await eventually(
      async () => (await t.api(owner).call('profiles.find', { type: 'email', value: 'ada@example.com' })).profileId,
      (p) => !!p,
    );
    await ingest([
      {
        type: 'track',
        event: 'Order Completed',
        anonymousId: 'anon-ada',
        messageId: 'order-1001',
        properties: { total: 499 },
        context: { ...prefs({ ad_measurement: true }), page: { url: `${SITE}/checkout/done`, path: '/checkout/done' } },
      },
    ]);
    const [req] = await eventually(
      async () => at('/v24.0/123456789/events'),
      (r) => r.length === 1,
      15_000,
    );
    const ev = req.body.data[0];
    expect(req.body.access_token).toBe('meta-system-user-token-0123456789');
    expect(req.body.test_event_code).toBeUndefined();
    expect(ev).toMatchObject({
      event_name: 'Purchase',
      event_id: 'order-1001',
      action_source: 'website',
      event_source_url: `${SITE}/checkout/done`,
      custom_data: { value: 499, currency: 'DKK' },
      user_data: { em: [sha256('ada@example.com')], ph: [sha256('4512345678')], client_user_agent: UA },
    });
    expect(ev.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR0abc$/);
    expect(JSON.stringify(req.body)).not.toContain('ada@example.com');
    const { conversions } = await eventually(
      () => t.api(owner).call('ads.conversions', {}),
      (r) => r.conversions[0]?.status === 'done',
    );
    expect(conversions[0]).toMatchObject({ platform: 'meta', event: 'Order Completed', value: 499, currency: 'DKK' });
  });

  it('sends a lead to Google with the click id, hashed e-mail and consent', async () => {
    await ingest([
      {
        type: 'track',
        event: 'Subscription Confirmed',
        anonymousId: 'anon-ada',
        messageId: 'lead-1',
        context: prefs({ ad_measurement: true, ad_targeting: false }),
      },
    ]);
    const [req] = await eventually(
      async () => at('/v1/events:ingest'),
      (r) => r.length === 1,
      15_000,
    );
    expect(req.auth).toBe('Bearer g-access');
    expect(req.body).toMatchObject({
      destinations: [{ operatingAccount: { accountId: '1234567890', accountType: 'GOOGLE_ADS' }, productDestinationId: '987654' }],
      encoding: 'HEX',
      events: [
        {
          transactionId: 'lead-1',
          adIdentifiers: { gclid: 'Cj0KCQada' },
          userData: { userIdentifiers: [{ emailAddress: sha256('ada@example.com') }, { phoneNumber: sha256('+4512345678') }] },
          consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
        },
      ],
    });
    await eventually(
      async () => at('/v24.0/123456789/events').filter((r) => r.body.data[0].event_name === 'Lead'),
      (r) => r.length === 1,
    );
  });

  it('sends nothing for people who did not allow ad_measurement', async () => {
    const before = received.length;
    await ingest([
      { type: 'identify', anonymousId: 'anon-bo', traits: { email: 'bo@example.com' }, context: prefs({ ad_measurement: false }) },
      {
        type: 'track',
        event: 'Order Completed',
        anonymousId: 'anon-bo',
        properties: { total: 99 },
        context: prefs({ ad_measurement: false }),
      },
    ]);
    await new Promise((r) => setTimeout(r, 2500));
    expect(received.length).toBe(before);
    expect((await t.api(owner).call('ads.conversions', {})).conversions.some((c) => c.value === 99)).toBe(false);
  });

  it('lists what was sent about a person in their data export', async () => {
    const { profileId } = await t.api(owner).call('profiles.find', { type: 'email', value: 'ada@example.com' });
    const exp = await t.api(owner).call('profiles.export', { profileId: profileId!, maxEvents: 0 });
    expect(exp.adUploads.map((u) => `${u.platform}:${u.event}`).sort()).toEqual([
      'google:Subscription Confirmed',
      'meta:Order Completed',
      'meta:Subscription Confirmed',
    ]);
  });
});

describe('test modes', () => {
  it("uses Meta's test event code and Google's validateOnly", async () => {
    const api = t.api(owner);
    expect(await api.call('ads.test', { connection: ids.meta })).toMatchObject({ ok: true, response: { events_received: 1 } });
    expect(at('/v24.0/123456789/events').at(-1)!.body).toMatchObject({ test_event_code: 'TEST123', data: [{ event_name: 'Lead' }] });
    expect(await api.call('ads.test', { connection: ids.google, conversionAction: '987654' })).toMatchObject({ ok: true });
    expect(at('/v1/events:ingest').at(-1)!.body.validateOnly).toBe(true);
    expect((await rejects(api.call('ads.test', { connection: ids.google }))).message).toContain('conversionAction');
  });
});
