import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 1 acceptance: "site events appear on a resolved profile within seconds; erasure verifiably
// removes a person". Runs the api, ingest and worker roles against Postgres, ClickHouse and NATS.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
const SHOP = 'https://shop.example.com';

beforeAll(async () => {
  t = await startTestServer('test_p1', 3298);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(() => t?.close());

const send = (key: string, body: unknown, opts: { origin?: string; path?: string } = {}) =>
  fetch(`${t.base}/v1/${opts.path ?? 'batch'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      ...(opts.origin === undefined ? { origin: SHOP } : opts.origin ? { origin: opts.origin } : {}),
    },
    body: JSON.stringify(body),
  });
const consent = (prefs: Record<string, boolean>) => ({ consent: { categoryPreferences: prefs } });

describe('sources and ingest', () => {
  let browserKey: string;

  it('creates sources: public browser keys, secret server keys shown once', async () => {
    const api = t.api(owner);
    expect((await rejects(api.call('sources.create', { name: 'Shop', kind: 'browser' }))).status).toBe(400);
    const browser = await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [SHOP] });
    expect(browser).toMatchObject({ kind: 'browser', requiredPurpose: 'analytics', writeKey: browser.key });
    browserKey = browser.key;
    const server = await api.call('sources.create', { name: 'Backend', kind: 'server' });
    expect(server.key).toMatch(/^sk_/);
    const { sources } = await api.call('sources.list', {});
    expect(sources.find((s) => s.id === server.id)).toMatchObject({ writeKey: null, requiredPurpose: null });
    expect(JSON.stringify(sources)).not.toContain(server.key);
  });

  it('accepts consented events from allowed origins and drops the rest', async () => {
    const batch = [
      { type: 'page', name: 'Home', anonymousId: 'anon-1', messageId: 'p1', context: consent({ analytics: true }) },
      {
        type: 'track',
        event: 'Product Viewed',
        anonymousId: 'anon-1',
        messageId: 't1',
        properties: { sku: 'TENT-2' },
        context: consent({ analytics: true }),
      },
      { type: 'track', event: 'Product Viewed', anonymousId: 'anon-2', messageId: 't2', context: consent({ analytics: false }) },
      { type: 'track', anonymousId: 'anon-3' },
    ];
    const res = await send(browserKey, { batch });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(await res.json()).toMatchObject({ success: true, accepted: 2, dropped: 1, rejected: [{ index: 3 }] });

    // Retried batch: JetStream drops the duplicates.
    expect(await (await send(browserKey, { batch: batch.slice(0, 2) })).json()).toMatchObject({ accepted: 2, duplicates: 2 });
    expect((await send(browserKey, { batch }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('pk_nope', { batch })).status).toBe(401);
    expect((await send(browserKey, { batch: [] })).status).toBe(400);

    // Segment's single-event paths, and sendBeacon-style text/plain with the key in the body.
    expect(
      (await send(browserKey, { event: 'Signed Up', anonymousId: 'anon-1', context: consent({ analytics: true }) }, { path: 't' })).status,
    ).toBe(200);
    const beacon = await fetch(`${t.base}/v1/p`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: SHOP },
      body: JSON.stringify({ writeKey: browserKey, anonymousId: 'anon-1', name: 'Pricing', context: consent({ analytics: true }) }),
    });
    expect(await beacon.json()).toMatchObject({ accepted: 1 });

    const stored = await eventually(
      () => t.srv.events.eventsOf(ws, { anonymousIds: ['anon-1', 'anon-2'], userIds: [] }),
      (e) => e.length >= 4,
    );
    expect(stored.map((e) => e.name).sort()).toEqual(['Home', 'Pricing', 'Product Viewed', 'Signed Up']);
    expect(stored.find((e) => e.name === 'Product Viewed')?.properties).toEqual({ sku: 'TENT-2' });
  });

  it('answers CORS preflights', async () => {
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'OPTIONS',
      headers: { origin: SHOP, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
  });
});
