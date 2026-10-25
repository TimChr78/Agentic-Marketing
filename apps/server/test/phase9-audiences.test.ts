import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { googleEmail, metaEmail, metaPhone, sha256 } from '@agentic-marketing/ads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, type User } from './harness';

// Phase 9 (wave 2), part 2: segments synced to Meta custom audiences and Google Customer Match
// (consent-gated, with removals and erasure), spend import with ROAS from our own attribution,
// and Microsoft offline conversions. A local server stands in for the platforms.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let browserKey = '';
const SITE = 'https://shop.example.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ids = { meta: '', google: '', microsoft: '', segment: '', sync: '' };

const received: { method: string; path: string; body: string; headers: Record<string, unknown> }[] = [];
let platformUrl = '';
const today = new Date().toISOString().slice(0, 10);
const platforms = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.url === '/token') return json(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    received.push({ method: req.method ?? '', path: req.url ?? '', body: raw, headers: req.headers });
    if (req.url?.startsWith('/v24.0/act_1234567/insights'))
      return json(200, {
        data: [
          {
            campaign_id: '601',
            campaign_name: 'Spring Sale',
            spend: '100.00',
            impressions: '5000',
            clicks: '120',
            date_start: today,
            account_currency: 'DKK',
            actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }],
          },
          {
            campaign_id: '602',
            campaign_name: 'Brand',
            spend: '50.00',
            impressions: '2000',
            clicks: '30',
            date_start: today,
            account_currency: 'DKK',
          },
        ],
      });
    if (req.url === '/v25/customers/1234567890/googleAds:search')
      return req.headers['developer-token'] === 'dev-token-123'
        ? json(200, {
            results: [
              {
                campaign: { id: '701', name: 'Search Tents' },
                segments: { date: today },
                metrics: { costMicros: '80000000', impressions: '900', clicks: '60', conversions: 3 },
                customer: { currencyCode: 'DKK' },
              },
            ],
          })
        : json(403, { error: { message: 'developer token' } });
    if (req.url === '/msads') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ApplyOfflineConversionsResponse xmlns="https://bingads.microsoft.com/CampaignManagement/v13"><PartialErrors/></ApplyOfflineConversionsResponse></s:Body></s:Envelope>',
      );
    }
    json(200, { ok: true });
  });
});
const at = (method: string, path: string) => received.filter((r) => r.method === method && r.path === path);

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
const consentEvent = (anon: string, c: Record<string, boolean>) => ({
  type: 'track',
  event: 'Segment Consent Preference Updated',
  anonymousId: anon,
  context: { consent: { categoryPreferences: { analytics: true, ...c } } },
});
const person = async (anon: string, email: string, phone: string, plan: string, adTargeting: boolean) => {
  await ingest([
    consentEvent(anon, { ad_targeting: adTargeting, ad_measurement: true }),
    {
      type: 'identify',
      anonymousId: anon,
      traits: { email, phone, plan },
      context: { consent: { categoryPreferences: { analytics: true } } },
    },
  ]);
  const { profileId } = await eventually(
    () => t.api(owner).call('profiles.find', { type: 'email', value: email }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => t.api(owner).call('consent.history', { profileId: profileId! }),
    (r) => r.records.some((x) => x.purpose === 'ad_targeting'),
  );
  return profileId!;
};
const connect = async (id: string) => {
  const { url } = await t.api(owner).call('connections.authorize', { id });
  expect((await fetch(`${t.base}/oauth/callback?code=c&state=${new URL(url).searchParams.get('state')}`)).status).toBe(200);
};

beforeAll(async () => {
  await new Promise<void>((r) => platforms.listen(0, '127.0.0.1', r));
  platformUrl = `http://127.0.0.1:${(platforms.address() as AddressInfo).port}`;
  t = await startTestServer('test_p9b', 3288);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner);
  browserKey = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [SITE] })).key;
  ids.meta = (
    await api.call('connections.create', {
      connector: 'meta_ads',
      name: 'Meta',
      settings: { pixelId: '123456789', adAccountId: 'act_1234567', apiBase: platformUrl },
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
        reportingBase: platformUrl,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'gc', clientSecret: 'gs', developerToken: 'dev-token-123' },
    })
  ).id;
  ids.microsoft = (
    await api.call('connections.create', {
      connector: 'microsoft_ads',
      name: 'Microsoft Ads',
      settings: {
        customerId: '111',
        accountId: '222',
        apiBase: `${platformUrl}/msads`,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'mc', clientSecret: 'ms', developerToken: 'ms-dev-token' },
    })
  ).id;
  await connect(ids.google);
  await connect(ids.microsoft);
  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Pro customers',
    content: { condition: { trait: 'plan', op: 'eq', value: 'pro' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'x' });
  ids.segment = seg.artifactId;
}, 60_000);
afterAll(async () => {
  await t?.close();
  platforms.close();
});

describe('audience sync', () => {
  let ada = '';
  let dan = '';

  it('adds segment members who allowed ad_targeting, hashed, to Meta and Google', async () => {
    const api = t.api(owner);
    ada = await person('anon-ada', 'ada@example.com', '+4512345678', 'pro', true);
    await person('anon-bo', 'bo@example.com', '+4587654321', 'pro', false);
    await person('anon-cy', 'cy@example.com', '+4511111111', 'basic', true);
    await eventually(
      () => api.call('segments.members', { artifactId: ids.segment }),
      (r) => r.members.length === 2,
      15_000,
    );
    const sync = await api.call('artifacts.create', {
      type: 'audience_sync',
      name: 'Pro customers → ads',
      content: {
        segment: ids.segment,
        meta: { connection: ids.meta, audienceId: '99887766' },
        google: { connection: ids.google, userListId: '555' },
      },
    });
    ids.sync = sync.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: ids.sync, note: 'x' });
    const { results } = await api.call('ads.syncAudience', { artifactId: ids.sync });
    expect(results).toEqual([
      expect.objectContaining({ platform: 'meta', status: 'ok', added: 1, members: 1 }),
      expect.objectContaining({ platform: 'google', status: 'ok', added: 1, members: 1 }),
    ]);
    const meta = JSON.parse(at('POST', '/v24.0/99887766/users')[0].body);
    expect(meta.payload).toEqual({ schema: ['EMAIL', 'PHONE'], data: [[metaEmail('ada@example.com'), metaPhone('+4512345678')]] });
    const google = JSON.parse(at('POST', '/v1/audienceMembers:ingest')[0].body);
    expect(google).toMatchObject({
      destinations: [{ productDestinationId: '555' }],
      audienceMembers: [
        { userData: { userIdentifiers: [{ emailAddress: googleEmail('ada@example.com') }, { phoneNumber: sha256('+4512345678') }] } },
      ],
      termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
    });
    expect((await api.call('ads.syncAudience', { artifactId: ids.sync })).results.every((r) => r.added === 0)).toBe(true);
  });

  it('removes people who withdraw ad_targeting, and people who are erased', async () => {
    const api = t.api(owner);
    dan = await person('anon-dan', 'dan@example.com', '+4522222222', 'pro', true);
    await eventually(
      () => api.call('segments.members', { artifactId: ids.segment }),
      (r) => r.members.length === 3,
      15_000,
    );
    await api.call('ads.syncAudience', { artifactId: ids.sync });

    await ingest([consentEvent('anon-ada', { ad_targeting: false })]);
    await eventually(
      () => api.call('consent.history', { profileId: ada }),
      (r) => r.records.some((x) => x.purpose === 'ad_targeting' && x.status !== 'granted'),
    );
    await api.call('profiles.erase', { profileId: dan, reason: 'Erasure request (test)' });
    const { results } = await api.call('ads.syncAudience', { artifactId: ids.sync });
    expect(results.map((r) => [r.platform, r.removed, r.members])).toEqual([
      ['meta', 2, 0],
      ['google', 2, 0],
    ]);
    const removed = JSON.parse(at('DELETE', '/v24.0/99887766/users')[0].body).payload.data.flat();
    expect(removed).toEqual(expect.arrayContaining([metaEmail('ada@example.com'), metaEmail('dan@example.com')]));
    expect(at('POST', '/v1/audienceMembers:remove')).toHaveLength(1);
    const { audiences } = await api.call('ads.audiences', {});
    expect(audiences[0].platforms).toEqual([
      expect.objectContaining({ platform: 'meta', members: 0, status: 'ok' }),
      expect.objectContaining({ platform: 'google', members: 0 }),
    ]);
  });

  it('removes people whose newer withdrawal is on one channel only (0.2.1, #103)', async () => {
    const api = t.api(owner);
    const fay = await person('anon-fay', 'fay@example.com', '+4544444444', 'pro', true);
    await eventually(
      () => api.call('segments.members', { artifactId: ids.segment }),
      (r) => r.members.some((m) => m.profileId === fay),
      15_000,
    );
    const added = await api.call('ads.syncAudience', { artifactId: ids.sync });
    expect(added.results.map((r) => [r.platform, r.added, r.members])).toEqual([
      ['meta', 1, 1],
      ['google', 1, 1],
    ]);
    // The all-channels grant stays; the newer web-only withdrawal decides.
    await api.call('consent.record', { profileId: fay, purpose: 'ad_targeting', channel: 'web', status: 'withdrawn' });
    const { results } = await api.call('ads.syncAudience', { artifactId: ids.sync });
    expect(results.map((r) => [r.platform, r.removed, r.members])).toEqual([
      ['meta', 1, 0],
      ['google', 1, 0],
    ]);
  });
});

describe('spend and ROAS', () => {
  it('imports spend and attributes our revenue by utm_campaign', async () => {
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
            microsoft: { connection: ids.microsoft, conversionName: 'Purchase' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'x' });
    expect(await api.call('ads.importSpend', { connection: ids.meta, days: 7 })).toMatchObject({ rows: 2 });
    expect(await api.call('ads.importSpend', { connection: ids.google, days: 7 })).toMatchObject({ rows: 1 });

    const ctx = (c: Record<string, boolean>) => ({ consent: { categoryPreferences: { analytics: true, ...c } } });
    await ingest([
      {
        type: 'page',
        anonymousId: 'anon-eve',
        context: {
          ...ctx({ ad_measurement: true }),
          page: { url: `${SITE}/?utm_source=facebook&utm_campaign=Spring%20Sale&msclkid=ms-click-1`, path: '/' },
        },
      },
      { type: 'identify', anonymousId: 'anon-eve', traits: { email: 'eve@example.com' }, context: ctx({ ad_measurement: true }) },
    ]);
    await new Promise((r) => setTimeout(r, 1000));
    await ingest([
      {
        type: 'track',
        event: 'Order Completed',
        anonymousId: 'anon-eve',
        properties: { total: 300 },
        context: ctx({ ad_measurement: true }),
      },
      {
        type: 'track',
        event: 'Order Completed',
        anonymousId: 'anon-fay',
        properties: { total: 40 },
        context: ctx({ ad_measurement: false }),
      },
    ]);
    const perf = await eventually(
      () => api.call('ads.performance', {}),
      (p) => p.totals.revenue === 300 && p.unattributed.conversions === 1,
      15_000,
    );
    expect(perf.campaigns.find((c) => c.campaignName === 'Spring Sale')).toMatchObject({
      platform: 'meta',
      cost: 100,
      conversions: 1,
      revenue: 300,
      roas: 3,
      cpa: 100,
      platformConversions: 2,
    });
    expect(perf.campaigns.find((c) => c.campaignId === '701')).toMatchObject({
      platform: 'google',
      cost: 80,
      impressions: 900,
      conversions: 0,
      roas: 0,
    });
    expect(perf.totals).toMatchObject({ cost: 230, conversions: 1, revenue: 300 });
    expect(perf.unattributed).toEqual({ conversions: 1, revenue: 40 });
  });

  it('sends the conversion to Microsoft with the msclkid through SOAP', async () => {
    const [req] = await eventually(
      async () => at('POST', '/msads'),
      (r) => r.length === 1,
      15_000,
    );
    expect(req.headers.soapaction).toBe('ApplyOfflineConversions');
    expect(req.body).toContain('<AuthenticationToken>access</AuthenticationToken>');
    expect(req.body).toContain('<DeveloperToken>ms-dev-token</DeveloperToken>');
    expect(req.body).toMatch(
      /<ConversionCurrencyCode>DKK<\/ConversionCurrencyCode><ConversionName>Purchase<\/ConversionName><ConversionTime>[^<]+<\/ConversionTime><ConversionValue>300<\/ConversionValue><HashedEmailAddress>[0-9a-f]{64}<\/HashedEmailAddress><MicrosoftClickId>ms-click-1<\/MicrosoftClickId>/,
    );
    expect(req.body).not.toContain('eve@example.com');
  });
});
