import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256 } from '@agentic-marketing/ads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Phase 11 (wave 2), part e: connectors. Conversions to LinkedIn, TikTok and Pinterest with their
// click ids; Salesforce (OAuth) actions and signed inbound callouts; the Shopify app: OAuth
// install, webhook registration, customer import with e-mail consent, and more order topics.
// One local server stands in for every platform.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let browserKey = '';
let base = '';
const SITE = 'https://shop.example.com';
const ids = { linkedin: '', tiktok: '', pinterest: '', salesforce: '', shopify: '' };
const inbound = { salesforce: '', shopify: '' };
const received: { method: string; path: string; body: any; headers: Record<string, unknown> }[] = [];
const sfContacts: { Id: string; Email: string }[] = [];
let webhookCalls = 0;

const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const url = new URL(req.url ?? '/', base);
    let body: any = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    received.push({ method: req.method ?? '', path: url.pathname + url.search, body, headers: req.headers });
    const p = url.pathname;
    if (p === '/token' || p === '/services/oauth2/token' || p === '/admin/oauth/access_token')
      return json(200, { access_token: `tok-${p.split('/')[1]}`, refresh_token: 'r', expires_in: 3600 });
    if (p === '/rest/conversionEvents') return res.writeHead(201).end();
    if (p === '/open_api/v1.3/event/track/') return json(200, { code: 0, message: 'OK' });
    if (p === '/v5/ad_accounts/123456/events') return json(200, { num_events_received: 1, events: [{ status: 'processed' }] });
    if (p === '/services/data/v64.0/query') {
      const q = url.searchParams.get('q') ?? '';
      const email = q.match(/Email = '((?:\\'|[^'])*)'/)?.[1]?.replace(/\\'/g, "'");
      return json(200, {
        totalSize: 1,
        records: sfContacts.filter((c) => c.Email === email).map((c) => ({ attributes: { type: 'Contact' }, ...c })),
      });
    }
    if (p === '/services/data/v64.0/sobjects/Contact' && req.method === 'POST') {
      const id = `003${String(sfContacts.length + 1).padStart(15, '0')}`;
      sfContacts.push({ Id: id, Email: body.Email });
      return json(201, { id, success: true });
    }
    if (p.startsWith('/services/data/v64.0/sobjects/Contact/') && req.method === 'PATCH') return res.writeHead(204).end();
    if (p === '/services/data/v64.0/sobjects/Task') return json(201, { id: '00T000000000001AAA', success: true });
    if (p === '/admin/api/2025-10/graphql.json') {
      if (req.headers['x-shopify-access-token'] !== 'tok-admin') return json(401, { errors: 'unauthorized' });
      if (String(body.query).includes('webhookSubscriptionCreate')) {
        webhookCalls++;
        const taken = body.variables.topic === 'ORDERS_CREATE';
        return json(200, {
          data: {
            webhookSubscriptionCreate: taken
              ? {
                  webhookSubscription: null,
                  userErrors: [{ field: ['address'], message: 'Address for this topic has already been taken' }],
                }
              : { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${webhookCalls}` }, userErrors: [] },
          },
        });
      }
      const page2 = body.variables.after === 'cursor-1';
      const customer = (n: number, state: string) => ({
        id: `gid://shopify/Customer/${n}`,
        email: `buyer${n}@example.com`,
        firstName: `Buyer${n}`,
        lastName: 'Example',
        phone: null,
        numberOfOrders: String(n),
        updatedAt: '2026-10-01T10:00:00Z',
        emailMarketingConsent: { marketingState: state, marketingOptInLevel: 'CONFIRMED_OPT_IN', consentUpdatedAt: '2026-09-01T10:00:00Z' },
      });
      return json(200, {
        data: {
          customers: page2
            ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [customer(1002, 'NOT_SUBSCRIBED')] }
            : { pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }, nodes: [customer(1001, 'SUBSCRIBED')] },
        },
      });
    }
    json(404, { message: `no route ${p}` });
  });
});
const at = (path: string) => received.filter((r) => r.path.startsWith(path));

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: SITE,
      authorization: `Basic ${Buffer.from(`${browserKey}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });
const prefs = { consent: { categoryPreferences: { analytics: true, ad_measurement: true } } };

async function connect(id: string) {
  const { url } = await t.api(owner).call('connections.authorize', { id });
  expect((await fetch(`${t.base}/oauth/callback?code=c&state=${new URL(url).searchParams.get('state')}`)).status).toBe(200);
}

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  t = await startTestServer('test_p11_conn', testPort(3296));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  browserKey = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [SITE] })).key;
  const create = (connector: string, settings: Record<string, unknown>, secrets: Record<string, unknown>) =>
    api.call('connections.create', { connector, name: connector, settings, secrets });
  ids.linkedin = (
    await create(
      'linkedin_ads',
      { apiBase: base, authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token` },
      { clientId: 'li-client', clientSecret: 'li-secret' },
    )
  ).id;
  ids.tiktok = (
    await create(
      'tiktok_ads',
      { pixelCode: 'C4ABCDEF123456', apiBase: base, testEventCode: 'TEST42' },
      { accessToken: 'tiktok-token-0123456789abcdef' },
    )
  ).id;
  ids.pinterest = (
    await create('pinterest_ads', { adAccountId: '123456', apiBase: base }, { accessToken: 'pina-token-0123456789abcdef' })
  ).id;
  const sf = await create(
    'salesforce',
    { instanceUrl: base, loginUrl: base },
    { clientId: 'sf-client', clientSecret: 'sf-secret', signingSecret: 'sf-signing-secret-0123456789' },
  );
  ids.salesforce = sf.id;
  inbound.salesforce = sf.inboundPath!;
  const shop = await create(
    'shopify_app',
    { shop: 'my-shop.myshopify.com', apiBase: base, syncEmailConsent: true },
    { clientId: 'shp-client', clientSecret: 'shp-secret' },
  );
  ids.shopify = shop.id;
  inbound.shopify = shop.inboundPath!;
  for (const id of [ids.linkedin, ids.salesforce, ids.shopify]) await connect(id);
}, 60_000);
afterAll(async () => {
  await t?.close();
  fake.close();
});

describe('conversions to LinkedIn, TikTok and Pinterest', () => {
  it('sends a purchase with each platform’s click id and hashed e-mail', async () => {
    const api = t.api(owner);
    const map = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Conversions',
      content: {
        rules: [
          {
            event: 'Order Completed',
            value: 'total',
            currency: 'DKK',
            linkedin: { connection: ids.linkedin, conversionId: '12345' },
            tiktok: { connection: ids.tiktok, event: 'CompletePayment' },
            pinterest: { connection: ids.pinterest, eventName: 'checkout' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'x' });
    await ingest([
      {
        type: 'page',
        anonymousId: 'anon-li',
        context: { ...prefs, page: { url: `${SITE}/?li_fat_id=li-abc-123&ttclid=E.C.P.tt123&epik=dj0yJnU9epik`, path: '/' } },
      },
      { type: 'identify', anonymousId: 'anon-li', traits: { email: 'Lin@Example.com' }, context: prefs },
    ]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'email', value: 'lin@example.com' }),
      (r) => !!r.profileId,
    );
    const clickIds = await eventually(
      async () =>
        (await t.srv.db.admin.query("SELECT count(*)::int AS n FROM identifiers WHERE type IN ('li_fat_id','ttclid','epik')")).rows[0].n,
      (n) => n === 3,
    );
    expect(clickIds).toBe(3);
    await ingest([{ type: 'track', event: 'Order Completed', anonymousId: 'anon-li', properties: { total: 100 }, context: prefs }]);
    await eventually(
      async () => [at('/rest/conversionEvents').length, at('/open_api').length, at('/v5/ad_accounts').length],
      (n) => n.every((x) => x === 1),
      15_000,
    );
    const li = at('/rest/conversionEvents')[0];
    expect(li.headers.authorization).toBe('Bearer tok-token');
    expect(li.body).toMatchObject({
      conversion: 'urn:lla:llaPartnerConversion:12345',
      conversionValue: { currencyCode: 'DKK', amount: '100' },
      user: {
        userIds: [
          { idType: 'SHA256_EMAIL', idValue: sha256('lin@example.com') },
          { idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: 'li-abc-123' },
        ],
      },
    });
    const tt = at('/open_api')[0];
    expect(tt.headers['access-token']).toBe('tiktok-token-0123456789abcdef');
    expect(tt.body).toMatchObject({
      event_source_id: 'C4ABCDEF123456',
      data: [
        {
          event: 'CompletePayment',
          user: { email: sha256('lin@example.com'), ttclid: 'E.C.P.tt123', external_id: sha256(profileId!) },
          properties: { value: 100, currency: 'DKK' },
        },
      ],
    });
    expect(tt.body.test_event_code).toBeUndefined();
    expect(at('/v5/ad_accounts')[0].body).toMatchObject({
      data: [
        {
          event_name: 'checkout',
          user_data: { em: [sha256('lin@example.com')], click_id: 'dj0yJnU9epik' },
          custom_data: { value: '100', currency: 'DKK' },
        },
      ],
    });
    // The platforms answered; each delivery is marked done just after its response.
    await eventually(
      async () => (await api.call('ads.conversions', {})).conversions.filter((c) => c.status === 'done').length,
      (n) => n === 3,
    );
  });

  it('tests TikTok and Pinterest in their test modes', async () => {
    const api = t.api(owner);
    expect(await api.call('ads.test', { connection: ids.tiktok, eventName: 'CompletePayment' })).toMatchObject({ ok: true });
    expect(at('/open_api').at(-1)?.body.test_event_code).toBe('TEST42');
    expect(await api.call('ads.test', { connection: ids.pinterest })).toMatchObject({ ok: true });
    expect(at('/v5/ad_accounts').at(-1)?.path).toContain('test=true');
    expect(await api.call('ads.test', { connection: ids.linkedin })).toMatchObject({
      ok: false,
      error: expect.stringContaining('no test mode'),
    });
  });
});

describe('Salesforce', () => {
  it('upserts contacts by e-mail, creates tasks and queries', async () => {
    const api = t.api(owner);
    const run = (action: string, input: Record<string, unknown>) =>
      api.call('connections.runAction', { id: ids.salesforce, action, input }).then((r) => r.result as Record<string, unknown>);
    const first = await run('upsertContact', { email: "o'brien@example.com", lastName: "O'Brien", fields: { LeadSource: 'Web' } });
    expect(first).toMatchObject({ created: true });
    // The quote is escaped in SOQL, so the same contact is found again.
    expect(decodeURIComponent(at('/services/data/v64.0/query')[0].path)).toContain("Email = 'o\\'brien@example.com'");
    expect(await run('upsertContact', { email: "o'brien@example.com", lastName: "O'Brien" })).toEqual({ id: first.id, created: false });
    expect(received.find((r) => r.method === 'PATCH')?.headers.authorization).toBe('Bearer tok-services');
    expect(await run('createTask', { subject: 'Call back', whoId: first.id })).toEqual({ id: '00T000000000001AAA' });
    const q = await run('query', { soql: "SELECT Id, Email FROM Contact WHERE Email = 'o\\'brien@example.com'" });
    expect(q.records).toEqual([{ Id: first.id, Email: "o'brien@example.com" }]);
    expect(
      (
        await api
          .call('connections.runAction', { id: ids.salesforce, action: 'query', input: { soql: 'DELETE FROM Contact' } })
          .catch((e) => e)
      ).status,
    ).toBe(400);
  });

  it('turns signed callouts into people, and refuses unsigned ones', async () => {
    const body = JSON.stringify({
      sobject: 'Contact',
      recordId: '003000000000009AAA',
      email: 'sf@example.com',
      event: 'Opportunity Won',
      properties: { amount: 5000 },
    });
    const sig = createHmac('sha256', 'sf-signing-secret-0123456789').update(body).digest('hex');
    expect(
      (await fetch(`${t.base}${inbound.salesforce}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status,
    ).toBe(401);
    const ok = await fetch(`${t.base}${inbound.salesforce}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-am-signature': sig },
      body,
    });
    expect(await ok.json()).toMatchObject({ accepted: 2 });
    const sf = await eventually(
      () => t.api(owner).call('profiles.find', { type: 'user_id', value: 'salesforce:003000000000009AAA' }),
      (r) => !!r.profileId,
    );
    expect(sf.profileId).toBeTruthy();
  });
});

describe('Shopify app', () => {
  it('registers its webhooks after the OAuth install', async () => {
    const r = await t.api(owner).call('connections.runAction', {
      id: ids.shopify,
      action: 'registerWebhooks',
      input: { inboundUrl: `https://marketing.example.com${inbound.shopify}` },
    });
    expect(r.result).toMatchObject({ alreadySubscribed: ['orders/create'] });
    expect((r.result as { subscribed: string[] }).subscribed).toContain('refunds/create');
    expect(at('/admin/api/2025-10/graphql.json').at(-1)?.body.variables.sub).toEqual({
      uri: `https://marketing.example.com${inbound.shopify}`,
      format: 'JSON',
    });
  });

  it('imports customers page by page, with their e-mail marketing consent', async () => {
    const api = t.api(owner);
    const p1 = await api.call('shopify.importCustomers', { connection: ids.shopify });
    expect(p1).toEqual({ imported: 1, consentRecords: 1, cursor: 'cursor-1', done: false });
    const p2 = await api.call('shopify.importCustomers', { connection: ids.shopify, cursor: p1.cursor! });
    expect(p2).toEqual({ imported: 1, consentRecords: 0, cursor: null, done: true });
    const subscribed = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'shopify:1001' }),
      (r) => !!r.profileId,
    );
    expect(subscribed.profileId).toBeTruthy();
    const consent = await eventually(
      () => api.call('consent.history', { profileId: subscribed.profileId! }),
      (h) => h.records.some((r) => r.purpose === 'marketing_email'),
    );
    expect(consent.records.find((r) => r.purpose === 'marketing_email')).toMatchObject({ status: 'granted' });
    const other = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'shopify:1002' }),
      (r) => !!r.profileId,
    );
    expect(other.profileId).toBeTruthy();
    expect(
      (await api.call('consent.history', { profileId: other.profileId! })).records.filter((r) => r.purpose === 'marketing_email'),
    ).toEqual([]);
  });

  it('receives fulfilment webhooks signed with the app secret', async () => {
    const body = JSON.stringify({
      id: 555,
      order_number: 1005,
      customer: { id: 1001, email: 'buyer1001@example.com' },
      total_price: '250.00',
      currency: 'DKK',
      updated_at: '2026-10-02T10:00:00Z',
      line_items: [],
    });
    const hmac = createHmac('sha256', 'shp-secret').update(body).digest('base64');
    const res = await fetch(`${t.base}${inbound.shopify}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'orders/fulfilled',
        'x-shopify-webhook-id': 'wh-1',
      },
      body,
    });
    expect(await res.json()).toMatchObject({ accepted: 2 });
    const { profileId } = await t.api(owner).call('profiles.find', { type: 'user_id', value: 'shopify:1001' });
    const { events } = await eventually(
      () => t.api(owner).call('profiles.events', { profileId: profileId! }),
      (r) => r.events.some((e) => e.name === 'Order Shipped'),
    );
    expect(events.find((e) => e.name === 'Order Shipped')?.properties).toMatchObject({ order_id: '555', total: 250, currency: 'DKK' });
  });
});
