import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ATTRIBUTION_LIMITS, googleEmail, metaEmail, metaPhone, sha256 } from '@agentic-marketing/ads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

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

/** A stored event with the id, time and page context an ads touch is read from. */
const storedEvent = (
  workspaceId: string,
  o: {
    eventId: string;
    type: 'track' | 'page';
    name: string;
    at: string;
    anonymousId: string;
    context?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  },
) => ({
  workspaceId,
  sourceId: 'test',
  messageId: o.eventId,
  type: o.type,
  name: o.name,
  anonymousId: o.anonymousId,
  userId: '',
  timestamp: o.at,
  receivedAt: o.at,
  properties: o.properties ?? {},
  traits: {},
  piiTraits: {},
  context: o.context ?? {},
  consent: {},
});

/** An ad_spend row, so a wrong touch lands in a visible campaign instead of unattributed. */
const spendRow = (workspaceId: string, campaignId: string, campaignName: string) => ({
  workspace_id: workspaceId,
  platform: 'meta',
  account: 'act_1234567',
  campaign_id: campaignId,
  campaign_name: campaignName,
  date: '2026-01-15',
  cost: 10,
  currency: 'DKK',
  impressions: 100,
  clicks: 10,
  platform_conversions: 1,
  updated_at: '2026-01-15 00:00:00.000',
});

/**
 * Runs `read` and records the row count of each touch response. The touch query is the one that
 * reads utm_campaign; its response must be at most one row per conversion (#786).
 */
async function touchQuerySizes<T>(read: () => Promise<T>): Promise<{ result: T; sizes: number[] }> {
  type QueryFn = typeof t.srv.events.client.query;
  const original = t.srv.events.client.query.bind(t.srv.events.client) as QueryFn;
  const sizes: number[] = [];
  const spy = vi.spyOn(t.srv.events.client, 'query').mockImplementation((async (args: Parameters<QueryFn>[0]) => {
    const rs = await original(args);
    if (typeof args.query === 'string' && args.query.includes('utm_campaign')) {
      const json = rs.json.bind(rs) as () => Promise<unknown>;
      (rs as unknown as { json: () => Promise<unknown> }).json = async () => {
        const rows = await json();
        sizes.push(Array.isArray(rows) ? rows.length : 0);
        return rows;
      };
    }
    return rs;
  }) as unknown as QueryFn);
  try {
    return { result: await read(), sizes };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  await new Promise<void>((r) => platforms.listen(0, '127.0.0.1', r));
  platformUrl = `http://127.0.0.1:${(platforms.address() as AddressInfo).port}`;
  t = await startTestServer('test_p9b', testPort(3288));
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
  it('always removes consent refusals with removals=false, including people outside the segment (#399)', async () => {
    const api = t.api(owner);
    const withdraw = await person('anon-retained-refusal', 'refusal@example.com', '+4555555555', 'retained-sync', true);
    const leave = await person('anon-retained-leaver', 'leaver@example.com', '+4566666666', 'retained-sync', true);
    const segment = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Retained sync fixture',
      content: { condition: { trait: 'plan', op: 'eq', value: 'retained-sync' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'Fixture' });
    await api.call('segments.refresh', { artifactId: segment.artifactId });
    const sync = await api.call('artifacts.create', {
      type: 'audience_sync',
      name: 'Keep ordinary leavers',
      content: {
        segment: segment.artifactId,
        removals: false,
        meta: { connection: ids.meta, audienceId: '88776655' },
        google: { connection: ids.google, userListId: '556' },
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: sync.artifactId, note: 'Fixture' });
    expect((await api.call('ads.syncAudience', { artifactId: sync.artifactId })).results.map((r) => [r.platform, r.members])).toEqual([
      ['meta', 2],
      ['google', 2],
    ]);
    await ingest(
      ['anon-retained-refusal', 'anon-retained-leaver'].map((anonymousId) => ({
        type: 'identify',
        anonymousId,
        traits: { plan: 'basic' },
        context: { consent: { categoryPreferences: { analytics: true } } },
      })),
    );
    for (const profileId of [withdraw, leave])
      await eventually(
        () => api.call('profiles.get', { profileId }),
        (r) => r.traits.plan === 'basic',
      );
    await api.call('segments.refresh', { artifactId: segment.artifactId });
    expect((await api.call('segments.members', { artifactId: segment.artifactId })).members).toEqual([]);
    await api.call('consent.record', { profileId: withdraw, purpose: 'ad_targeting', status: 'withdrawn' });
    const first = await api.call('ads.syncAudience', { artifactId: sync.artifactId });
    expect(first.results.map((r) => [r.platform, r.removed, r.members])).toEqual([
      ['meta', 1, 1],
      ['google', 1, 1],
    ]);
    // The ordinary leaver remains until they too withdraw, even though neither person is in the segment.
    await api.call('consent.record', { profileId: leave, purpose: 'ad_targeting', channel: 'web', status: 'denied' });
    const second = await api.call('ads.syncAudience', { artifactId: sync.artifactId });
    expect(second.results.map((r) => [r.platform, r.removed, r.members])).toEqual([
      ['meta', 1, 0],
      ['google', 1, 0],
    ]);
  }, 30_000);
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

    // #640: a server-side order carries only a user id (the shape Shopify orders produce). It has
    // no campaign touch, but it is still one of our conversions and must appear in the totals as
    // unattributed instead of being filtered out before the attribution loop.
    await ingest([
      {
        type: 'track',
        event: 'Order Completed',
        userId: 'shop-buyer-1',
        properties: { total: 70 },
        context: ctx({ ad_measurement: true }),
      },
    ]);
    const withServerSide = await eventually(
      () => api.call('ads.performance', {}),
      (p) => p.unattributed.revenue === 110,
      15_000,
    );
    // The attributed totals do not move (there is no campaign touch); the conversion is in the
    // report as unattributed, where the output says conversions without a touch belong.
    expect(withServerSide.totals).toMatchObject({ conversions: 1, revenue: 300 });
    expect(withServerSide.unattributed).toEqual({ conversions: 2, revenue: 110 });
  });

  it('reads only the last touch per conversion, ignoring later and out-of-window touches (#786)', async () => {
    const work = await t.workspaceWith([[owner, 'owner']]);
    const api = t.api(owner, work);
    const microsoft = await api.call('connections.create', {
      connector: 'microsoft_ads',
      name: 'Microsoft',
      settings: {
        customerId: '111',
        accountId: '222',
        apiBase: `${platformUrl}/msads`,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'mc', clientSecret: 'ms', developerToken: 'ms-dev-token' },
    });
    const map = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Touch attribution',
      content: {
        rules: [
          {
            event: 'Touch Purchase',
            value: 'total',
            currency: 'DKK',
            microsoft: { connection: microsoft.id, conversionName: 'Purchase' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'touch' });

    const touch = (eventId: string, at: string, campaign: string) =>
      storedEvent(work, {
        eventId,
        type: 'page',
        name: 'Page View',
        at,
        anonymousId: 'anon-many-touches',
        context: { page: { url: `https://shop.example.com/?utm_source=facebook&utm_campaign=${encodeURIComponent(campaign)}` } },
      });
    // 500 touches before the conversion make the old unbounded response large; only the last
    // in-window touch may survive. The others are out of the 7-day window or after the conversion
    // (one is even after the report window), and the old query loaded all of them.
    const noise = Array.from({ length: 500 }, (_, i) =>
      touch(`noise-${i}`, new Date(Date.parse('2026-01-20T00:00:00.000Z') + i * 60_000).toISOString(), 'Noise'),
    );
    await t.srv.events.insert([
      ...noise,
      touch('touch-out-of-window', '2026-01-10T12:00:00.000Z', 'Out Of Window'),
      touch('touch-older', '2026-01-20T09:00:00.000Z', 'Older'),
      touch('touch-last', '2026-01-20T11:00:00.000Z', 'Last Touch'),
      touch('touch-after', '2026-01-20T13:00:00.000Z', 'After'),
      touch('touch-after-report', '2026-02-05T12:00:00.000Z', 'After Report'),
      storedEvent(work, {
        eventId: 'touch-conversion',
        type: 'track',
        name: 'Touch Purchase',
        at: '2026-01-20T12:00:00.000Z',
        anonymousId: 'anon-many-touches',
        properties: { total: 50 },
      }),
    ]);
    await t.srv.events.client.insert({
      table: 'ad_spend',
      format: 'JSONEachRow',
      values: [
        spendRow(work, 'noise', 'Noise'),
        spendRow(work, 'out', 'Out Of Window'),
        spendRow(work, 'older', 'Older'),
        spendRow(work, 'last', 'Last Touch'),
        spendRow(work, 'after', 'After'),
        spendRow(work, 'after-report', 'After Report'),
      ],
    });

    const { result, sizes } = await touchQuerySizes(() =>
      api.call('ads.performance', { since: '2026-01-01', until: '2026-01-31', windowDays: 7 }),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((n) => n <= 1)).toBe(true);
    const byId = new Map(result.campaigns.map((c) => [c.campaignId, c]));
    expect(byId.get('last')).toMatchObject({ conversions: 1, revenue: 50, cpa: 10, roas: 5 });
    for (const id of ['noise', 'out', 'older', 'after', 'after-report']) expect(byId.get(id)!.conversions).toBe(0);
    expect(result.unattributed).toEqual({ conversions: 0, revenue: 0 });
  });

  it('refuses a report whose touch and conversion pairs exceed the attribution budget (0.14.12 review round 4)', async () => {
    const work = await t.workspaceWith([[owner, 'owner']]);
    const api = t.api(owner, work);
    const microsoft = await api.call('connections.create', {
      connector: 'microsoft_ads',
      name: 'Microsoft',
      settings: {
        customerId: '111',
        accountId: '222',
        apiBase: `${platformUrl}/msads`,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'mc', clientSecret: 'ms', developerToken: 'ms-dev-token' },
    });
    const map = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Budget attribution',
      content: {
        rules: [
          {
            event: 'Budget Purchase',
            value: 'total',
            currency: 'DKK',
            microsoft: { connection: microsoft.id, conversionName: 'Purchase' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'budget' });
    // One visitor, 20 campaign touches and 10 conversions: 200 candidate pairs.
    const at = (i: number) => new Date(Date.parse('2026-01-20T00:00:00.000Z') + i * 60_000).toISOString();
    await t.srv.events.insert([
      ...Array.from({ length: 20 }, (_, i) =>
        storedEvent(work, {
          eventId: `budget-touch-${i}`,
          type: 'page',
          name: 'Page View',
          at: at(i),
          anonymousId: 'anon-budget',
          context: { page: { url: 'https://shop.example.com/?utm_source=facebook&utm_campaign=Budget' } },
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        storedEvent(work, {
          eventId: `budget-conversion-${i}`,
          type: 'track',
          name: 'Budget Purchase',
          at: at(30 + i),
          anonymousId: 'anon-budget',
          properties: { total: 10 },
        }),
      ),
    ]);
    const report = () => api.call('ads.performance', { since: '2026-01-01', until: '2026-01-31', windowDays: 7 });
    const saved = { ...ATTRIBUTION_LIMITS };
    try {
      ATTRIBUTION_LIMITS.pairsPerQuery = 100;
      await expect(report()).rejects.toMatchObject({ code: 'precondition_failed', message: expect.stringContaining('200') });
      ATTRIBUTION_LIMITS.pairsPerQuery = saved.pairsPerQuery;
      ATTRIBUTION_LIMITS.pairsPerReport = 150;
      await expect(report()).rejects.toMatchObject({ code: 'precondition_failed' });
    } finally {
      Object.assign(ATTRIBUTION_LIMITS, saved);
    }
    // Within the budget the same report attributes every conversion.
    const result = await report();
    expect(result.unattributed).toEqual({ conversions: 10, revenue: 100 });
  });

  it('breaks a same-time touch tie deterministically by event id (#786)', async () => {
    const work = await t.workspaceWith([[owner, 'owner']]);
    const api = t.api(owner, work);
    const microsoft = await api.call('connections.create', {
      connector: 'microsoft_ads',
      name: 'Microsoft',
      settings: {
        customerId: '111',
        accountId: '222',
        apiBase: `${platformUrl}/msads`,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'mc', clientSecret: 'ms', developerToken: 'ms-dev-token' },
    });
    const map = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Tie attribution',
      content: {
        rules: [
          {
            event: 'Tie Purchase',
            value: 'total',
            currency: 'DKK',
            microsoft: { connection: microsoft.id, conversionName: 'Purchase' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'tie' });

    const touch = (eventId: string, campaign: string) =>
      storedEvent(work, {
        eventId,
        type: 'page',
        name: 'Page View',
        at: '2026-01-20T10:00:00.000Z',
        anonymousId: 'anon-tie',
        context: { page: { url: `https://shop.example.com/?utm_source=facebook&utm_campaign=${encodeURIComponent(campaign)}` } },
      });
    // Inserted out of order on purpose: the winner must come from event_id, not storage order.
    await t.srv.events.insert([
      touch('tie-b', 'Tie B'),
      touch('tie-a', 'Tie A'),
      storedEvent(work, {
        eventId: 'tie-conversion',
        type: 'track',
        name: 'Tie Purchase',
        at: '2026-01-20T12:00:00.000Z',
        anonymousId: 'anon-tie',
        properties: { total: 20 },
      }),
    ]);
    await t.srv.events.client.insert({
      table: 'ad_spend',
      format: 'JSONEachRow',
      values: [spendRow(work, 'tie-a', 'Tie A'), spendRow(work, 'tie-b', 'Tie B')],
    });

    const { result, sizes } = await touchQuerySizes(() =>
      api.call('ads.performance', { since: '2026-01-01', until: '2026-01-31', windowDays: 7 }),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((n) => n <= 1)).toBe(true);
    const byId = new Map(result.campaigns.map((c) => [c.campaignId, c]));
    expect(byId.get('tie-b')).toMatchObject({ conversions: 1, revenue: 20 });
    expect(byId.get('tie-a')!.conversions).toBe(0);
    // Same data, same answer.
    const again = await api.call('ads.performance', { since: '2026-01-01', until: '2026-01-31', windowDays: 7 });
    expect(again.campaigns.find((c) => c.campaignId === 'tie-b')).toMatchObject({ conversions: 1 });
    expect(again.campaigns.find((c) => c.campaignId === 'tie-a')!.conversions).toBe(0);
  });

  it('attributes more than 100,000 conversions with distinct anonymous ids (#786)', async () => {
    // A fresh workspace keeps the totals exact: the conversions below are its only events.
    const work = await t.workspaceWith([[owner, 'owner']]);
    const api = t.api(owner, work);
    const microsoft = await api.call('connections.create', {
      connector: 'microsoft_ads',
      name: 'Microsoft',
      settings: {
        customerId: '111',
        accountId: '222',
        apiBase: `${platformUrl}/msads`,
        authorizeUrl: `${platformUrl}/authorize`,
        tokenUrl: `${platformUrl}/token`,
      },
      secrets: { clientId: 'mc', clientSecret: 'ms', developerToken: 'ms-dev-token' },
    });
    const map = await api.call('artifacts.create', {
      type: 'conversion_map',
      name: 'Bulk conversions',
      content: {
        rules: [
          {
            event: 'Bulk Purchase',
            value: 'total',
            currency: 'DKK',
            microsoft: { connection: microsoft.id, conversionName: 'Purchase' },
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'bulk' });

    // Each id is 37 characters. The old single `visitors:Array(String)` parameter serialised all
    // 100,001 of them into one HTTP form field, which ClickHouse rejects as "Field value too long"
    // long before attribution starts. The ids are distinct and have no campaign touch, so every
    // conversion must come back unattributed.
    const settings = await t.srv.events.settingsFor(work);
    await t.srv.events.client.command({
      query: `INSERT INTO events
                (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                 anonymous_id, user_id, profile_id, properties, traits, context, consent)
              SELECT {ws:UUID}, concat('bulk-ad-', toString(number)), 'src_bulk',
                     {at:DateTime64(3, 'UTC')}, {at:DateTime64(3, 'UTC')},
                     'track', 'Bulk Purchase',
                     concat('anon-', leftPad(toString(number), 32, '0')), '', '',
                     CAST('{"total":1}' AS JSON), CAST('{}' AS JSON), CAST('{}' AS JSON), map()
              FROM numbers({n:UInt32})`,
      query_params: { ws: work, at: '2026-11-05 00:00:00.000', n: 100_001 },
      clickhouse_settings: settings as never,
    });

    const report = await api.call('ads.performance', { since: '2026-11-01', until: '2026-11-12', windowDays: 30 });
    expect(report.unattributed).toEqual({ conversions: 100_001, revenue: 100_001 });
    expect(report.totals).toEqual({ cost: 0, conversions: 0, revenue: 0, roas: null });
  }, 180_000);

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
