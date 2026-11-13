import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.14.11 (#764, #787):
// - a connector's mapped events are platform-produced, so a strict tracking plan must not reject
//   them while the route answers the sender 200;
// - replay protection must cover every inbound scheme, not only Standard Webhooks: hmac-sha256 has
//   no timestamp or nonce and an unsigned secret URL has nothing at all, so the raw body is the
//   only stable identity a byte-identical replay has.

const PORT = testPort(4340);
const SHOPIFY_SECRET = 'shp-secret';
const HMAC_SECRET = 'hmac-secret-0123456789';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let strictWs = '';
let plainWs = '';

const api = (ws = strictWs) => t.api(owner, ws);

const shopper = (id: number) =>
  JSON.stringify({
    id,
    order_number: 1000 + id,
    customer: { id, email: `buyer${id}@example.com` },
    total_price: '250.00',
    currency: 'DKK',
    updated_at: '2026-11-12T10:00:00Z',
    line_items: [],
  });

const tracked = (userId: string, orderId: string) =>
  JSON.stringify({ type: 'track', event: 'Order Completed', userId, properties: { order_id: orderId } });

beforeAll(async () => {
  t = await startTestServer('test_v01411_ingest', PORT);
  owner = await t.signUp(`owner-01411-ingest-${Date.now()}@example.com`);
  strictWs = await t.workspaceWith([[owner, 'owner']]);
  plainWs = await t.workspaceWith([[owner, 'owner']]);

  const { artifactId } = await api().call('artifacts.create', {
    type: 'tracking_plan',
    name: 'Strict product analytics',
    content: { unknownEvents: 'block', unknownProperties: 'block', events: [] },
  });
  await api().call('artifacts.requestPublish', { artifactId, note: 'strict plan' });

  await api(plainWs).call('sources.create', { name: 'Activity', kind: 'server' });
}, 60_000);

afterAll(() => t?.close());

describe('a strict tracking plan and connector-mapped events (#764)', () => {
  it('publishes a Shopify order even though the plan declares no events', async () => {
    const connection = await api().call('connections.create', {
      connector: 'shopify',
      name: 'Shopify strict plan',
      settings: { shop: 'strict-plan.myshopify.com' },
      secrets: { webhookSecret: SHOPIFY_SECRET },
    });
    const body = shopper(7001);
    const res = await fetch(`${t.base}${connection.inboundPath!}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh-strict-1',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, accepted: 2, dropped: 0 });

    const stored = await eventually(
      () => t.srv.events.eventsOf(strictWs, { anonymousIds: [], userIds: ['shopify:7001'] }),
      (events) => events.some((e) => e.name === 'Order Completed'),
    );
    expect(stored.find((e) => e.name === 'Order Completed')?.properties).toMatchObject({ order_id: '7001', total: 250 });
  });
});

describe('inbound replay protection for every scheme (#787)', () => {
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${t.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('publishes a byte-identical hmac-sha256 replay once and a different body again', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Signed generic',
      settings: { mapping: 'body', signature: { scheme: 'hmac-sha256', header: 'x-signature', encoding: 'hex', prefix: '' } },
      secrets: { signingSecret: HMAC_SECRET },
    });
    const sign = (body: string) => createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
    const events = () =>
      t.srv.events
        .eventsOf(plainWs, { anonymousIds: [], userIds: ['hmac-replay'] })
        .then((rows) => rows.filter((e) => e.name === 'Order Completed'));

    const body = tracked('hmac-replay', 'h-1');
    const first = await post(connection.inboundPath!, body, { 'x-signature': sign(body) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    await eventually(events, (rows) => rows.length === 1);

    const replay = await post(connection.inboundPath!, body, { 'x-signature': sign(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
    expect(await events()).toHaveLength(1);

    const changed = tracked('hmac-replay', 'h-2');
    const again = await post(connection.inboundPath!, changed, { 'x-signature': sign(changed) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ success: true, accepted: 1 });
    await eventually(events, (rows) => rows.length === 2);
  });

  it('keeps two deliveries with the same body but different mapped event ids (0.14.11 review)', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Header-keyed generic',
      settings: { mapping: '$merge([body, {"messageId": headers."x-event-id"}])' },
      secrets: {},
    });
    const events = () =>
      t.srv.events
        .eventsOf(plainWs, { anonymousIds: [], userIds: ['header-keyed'] })
        .then((rows) => rows.filter((e) => e.name === 'Order Completed'));

    const body = tracked('header-keyed', 'h-1');
    const first = await post(connection.inboundPath!, body, { 'x-event-id': 'evt-1' });
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    const second = await post(connection.inboundPath!, body, { 'x-event-id': 'evt-2' });
    expect(await second.json()).toMatchObject({ success: true, accepted: 1 });
    await eventually(events, (rows) => rows.length === 2);

    const replay = await post(connection.inboundPath!, body, { 'x-event-id': 'evt-2' });
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
    expect(await events()).toHaveLength(2);
  });

  it('keeps same-body deliveries whose mapped headers differ outside messageId (0.14.11 round 2)', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Device-keyed generic',
      settings: { mapping: '$merge([body, {"anonymousId": headers."x-device", "timestamp": headers."x-sent-at"}])' },
      secrets: {},
    });
    const body = tracked('device-keyed', 'd-1');
    const first = await post(connection.inboundPath!, body, { 'x-device': 'dev-a', 'x-sent-at': '2026-11-12T10:00:00Z' });
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    const second = await post(connection.inboundPath!, body, { 'x-device': 'dev-b', 'x-sent-at': '2026-11-12T10:05:00Z' });
    expect(await second.json()).toMatchObject({ success: true, accepted: 1 });
    // A different per-hop header (user-agent) does not make a replay distinct.
    const replay = await post(connection.inboundPath!, body, {
      'x-device': 'dev-b',
      'x-sent-at': '2026-11-12T10:05:00Z',
      'user-agent': 'retry/2',
    });
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
  });

  it('keeps same-body deliveries from two client addresses a mapping looks up (0.14.11 round 3)', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Address-keyed generic',
      settings: { mapping: '$merge([body, {"anonymousId": $lookup(headers, "x-forwarded-for")}])' },
      secrets: {},
    });
    const body = tracked('address-keyed', 'a-1');
    const first = await post(connection.inboundPath!, body, { 'x-forwarded-for': '192.0.2.1' });
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    const second = await post(connection.inboundPath!, body, { 'x-forwarded-for': '192.0.2.2' });
    expect(await second.json()).toMatchObject({ success: true, accepted: 1 });
  });

  it('keeps a Shopify order paid with the same body as its create (0.14.11 round 3)', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'shopify',
      name: 'Shopify topics',
      settings: { shop: 'topics.myshopify.com' },
      secrets: { webhookSecret: SHOPIFY_SECRET },
    });
    const body = shopper(7002);
    const send = (topic: string, id: string) =>
      post(connection.inboundPath!, body, {
        'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
        'x-shopify-topic': topic,
        'x-shopify-webhook-id': id,
      });
    expect(await (await send('orders/create', 'wh-topic-1')).json()).toMatchObject({ success: true });
    const paid = await (await send('orders/paid', 'wh-topic-2')).json();
    expect(paid).not.toHaveProperty('duplicate');
    expect(paid.accepted).toBeGreaterThan(0);
    // A retry of the same topic is still a replay.
    expect(await (await send('orders/paid', 'wh-topic-2')).json()).toMatchObject({ duplicate: true });
  });

  it('still recognises a replay when the mapping generates a fresh messageId (0.14.11 round 2)', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Clock-keyed generic',
      settings: { mapping: '$merge([body, {"messageId": $string($millis())}])' },
      secrets: {},
    });
    const body = tracked('clock-keyed', 'c-1');
    const first = await post(connection.inboundPath!, body);
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    const replay = await post(connection.inboundPath!, body);
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
  });

  it('publishes a byte-identical unsigned replay once and a different body again', async () => {
    const connection = await api(plainWs).call('connections.create', {
      connector: 'webhook',
      name: 'Unsigned generic',
      settings: { mapping: 'body' },
      secrets: {},
    });
    const events = () =>
      t.srv.events
        .eventsOf(plainWs, { anonymousIds: [], userIds: ['unsigned-replay'] })
        .then((rows) => rows.filter((e) => e.name === 'Order Completed'));

    const body = tracked('unsigned-replay', 'u-1');
    const first = await post(connection.inboundPath!, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    await eventually(events, (rows) => rows.length === 1);

    const replay = await post(connection.inboundPath!, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
    expect(await events()).toHaveLength(1);

    const changed = tracked('unsigned-replay', 'u-2');
    expect((await post(connection.inboundPath!, changed)).status).toBe(200);
    await eventually(events, (rows) => rows.length === 2);
  });
});
