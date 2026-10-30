import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhook } from '@agentic-marketing/integrations';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 5 acceptance: "webhooks in/out work end-to-end; n8n can orchestrate via MCP/webhooks;
// connector SDK documented". A local receiver plays n8n, Slack and the outside world.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let key: string;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
/** Status codes to answer per path, in order; 200 when the list is empty. */
const script = new Map<string, number[]>();
let receiverUrl = '';
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body });
    res.statusCode = script.get(req.url ?? '')?.shift() ?? 200;
    res.end(res.statusCode === 200 ? 'ok' : 'nope');
  });
});
const at = (path: string) => received.filter((r) => r.path === path);

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

beforeAll(async () => {
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  t = await startTestServer('test_p5', testPort(3296));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(async () => {
  await t?.close();
  receiver.close();
});

describe('API tokens (scripts, n8n)', () => {
  it('act as an agent with the chosen scopes over REST and MCP, until revoked', async () => {
    const api = t.api(owner);
    const tok = await api.call('apiTokens.create', { name: 'n8n', scopes: ['artifacts:read', 'artifacts:write'] });
    expect(tok.token).toMatch(/^amk_/);
    expect(JSON.stringify(await api.call('apiTokens.list', {}))).not.toContain(tok.token);

    const rest = (name: string, body: unknown) =>
      fetch(`${t.base}/v1/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` },
        body: JSON.stringify(body),
      });
    const note = await rest('artifacts.create', { type: 'note', name: 'From n8n', content: { title: 'Hi', body: 'x' } });
    expect(note.status).toBe(200);
    const refused = await rest('artifacts.requestPublish', { artifactId: (await note.json()).artifactId, note: 'x' });
    expect(refused.status).toBe(403);
    expect((await rest('apiTokens.create', { name: 'x', scopes: ['artifacts:read'] })).status).toBe(403);

    const mcp = new Client({ name: 'n8n', version: '1' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.token}` } } }),
    );
    const tools = (await mcp.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('artifacts.create');
    expect(tools).not.toContain('artifacts.requestPublish');
    await mcp.close();

    const audit = await api.call('audit.list', { limit: 10 });
    expect(audit.entries.find((e) => e.command === 'artifacts.create')).toMatchObject({
      principalType: 'agent',
      clientId: `token:${tok.id}`,
    });

    await api.call('apiTokens.revoke', { id: tok.id });
    expect((await rest('artifacts.list', {})).status).toBe(401);
  });
});

describe('outbound webhooks', () => {
  let endpoint: { id: string; secret: string };

  it('refuses private addresses and signs, retries and dead-letters deliveries', async () => {
    const api = t.api(owner);
    expect(
      (await rejects(api.call('webhooks.create', { name: 'Metadata', url: 'http://169.254.169.254/latest', events: ['*'] }))).message,
    ).toContain('private address');
    endpoint = await api.call('webhooks.create', { name: 'n8n', url: `${receiverUrl}/n8n`, events: ['Order Completed'] });
    const flaky = await api.call('webhooks.create', { name: 'Broken', url: `${receiverUrl}/broken`, events: ['Order Completed'] });
    const gated = await api.call('webhooks.create', {
      name: 'Ads',
      url: `${receiverUrl}/ads`,
      events: ['Order Completed'],
      purpose: 'marketing_email',
    });
    script.set('/n8n', [500]);
    script.set('/broken', [500, 500, 500]);

    await send([
      { type: 'identify', userId: 'ada', traits: { email: 'ada@example.com', plan: 'pro' } },
      { type: 'track', event: 'Order Completed', userId: 'ada', messageId: 'order-1', properties: { total: 899 } },
      { type: 'track', event: 'Product Viewed', userId: 'ada' },
    ]);
    const got = await eventually(
      async () => at('/n8n'),
      (r) => r.length === 2,
    );
    // The first attempt failed; the retry has the same id and a valid signature.
    expect(got[0].headers['webhook-id']).toBe(got[1].headers['webhook-id']);
    const h = got[1].headers as Record<string, string>;
    expect(verifyWebhook(endpoint.secret, h, got[1].body)).toBe(true);
    expect(verifyWebhook(endpoint.secret, h, got[1].body.replace('899', '1'))).toBe(false);
    const payload = JSON.parse(got[1].body);
    expect(payload).toMatchObject({
      type: 'event.track',
      data: { event: { name: 'Order Completed', messageId: 'order-1', properties: { total: 899 } }, profile: { traits: { plan: 'pro' } } },
    });
    expect(got[1].body).not.toContain('ada@example.com');

    const dead = await eventually(
      () => api.call('deliveries.list', { targetId: flaky.id }),
      (r) => r.deliveries[0]?.status === 'dead',
    );
    expect(dead.deliveries[0]).toMatchObject({ attempts: 3, statusCode: 500 });
    await api.call('deliveries.retry', { id: dead.deliveries[0].id });
    await eventually(
      () => api.call('deliveries.list', { targetId: flaky.id }),
      (r) => r.deliveries[0]?.status === 'done',
    );
    // No marketing consent: nothing for the purpose-bound endpoint.
    expect((await api.call('deliveries.list', { targetId: gated.id })).deliveries).toHaveLength(0);
  });
});

describe('inbound webhooks and connectors', () => {
  it('lists the connectors with their schemas', async () => {
    const { connectors } = await t.api(owner).call('connectors.list', {});
    expect(connectors.map((c) => c.id)).toEqual([
      'webhook',
      'shopify',
      'shopify_app',
      'salesforce',
      'slack',
      'http',
      'oauth_http',
      'meta_ads',
      'google_ads',
      'microsoft_ads',
      'linkedin_ads',
      'tiktok_ads',
      'pinterest_ads',
    ]);
    expect(connectors.find((c) => c.id === 'slack')!.actions.map((a) => a.name)).toEqual(['postMessage']);
  });

  it('turns signed Shopify webhooks into profiles and events, and refuses bad signatures', async () => {
    const api = t.api(owner);
    const conn = await api.call('connections.create', { connector: 'shopify', name: 'Shop', secrets: { webhookSecret: 'shpss_test' } });
    expect(conn.inboundPath).toMatch(/^\/hooks\/in\/con_/);
    const order = {
      id: 5001,
      order_number: 1042,
      email: 'bo@example.com',
      total_price: '1299.00',
      currency: 'DKK',
      created_at: '2026-10-20T10:00:00Z',
      customer: { id: 77, email: 'bo@example.com', first_name: 'Bo' },
      line_items: [{ product_id: 9, title: 'Fjell 2 tent', price: '1299.00', quantity: 1 }],
    };
    const body = JSON.stringify(order);
    const post = (sig: string, path = conn.inboundPath!) =>
      fetch(`${t.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': 'orders/create',
          'x-shopify-webhook-id': 'w-1',
          'x-shopify-hmac-sha256': sig,
        },
        body,
      });
    expect((await post('bad')).status).toBe(401);
    expect((await post('x', `${conn.inboundPath!.slice(0, -3)}abc`)).status).toBe(404);
    const ok = await post(createHmac('sha256', 'shpss_test').update(body).digest('base64'));
    expect(await ok.json()).toMatchObject({ success: true, accepted: 2 });

    const profileId = (
      await eventually(
        () => api.call('profiles.find', { type: 'email', value: 'bo@example.com' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const { events } = await eventually(
      () => api.call('profiles.events', { profileId }),
      (r) => r.events.some((e) => e.name === 'Order Completed'),
    );
    expect(events.find((e) => e.name === 'Order Completed')!.properties).toMatchObject({ order_id: '5001', total: 1299, currency: 'DKK' });
  });

  it('maps any JSON with a JSONata mapping, verifying an HMAC signature', async () => {
    const api = t.api(owner);
    const conn = await api.call('connections.create', {
      connector: 'webhook',
      name: 'Typeform',
      settings: {
        mapping: '{"type": "track", "event": "Lead Created", "userId": "lead:" & body.id, "properties": {"score": body.score}}',
        signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=' },
      },
      secrets: { signingSecret: 'lead-secret' },
    });
    const body = JSON.stringify({ id: 'L1', score: 87 });
    const res = await fetch(`${t.base}${conn.inboundPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'lead-secret').update(body).digest('hex')}`,
      },
      body,
    });
    expect(await res.json()).toMatchObject({ success: true, accepted: 1 });
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'lead:L1' }),
      (r) => !!r.profileId,
    );
    expect(profileId).toBeTruthy();
  });
});

describe('automation steps in journeys', () => {
  let journeyId: string;
  let slack: string;
  let hook: string;

  it('checks connections and actions on publish, and simulates both outcomes', async () => {
    const api = t.api(owner);
    slack = (
      await api.call('connections.create', { connector: 'slack', name: 'Sales channel', secrets: { webhookUrl: `${receiverUrl}/slack` } })
    ).id;
    hook = (await api.call('webhooks.create', { name: 'CRM', url: `${receiverUrl}/crm` })).id;
    const def = (action: string) => ({
      purpose: 'onboarding',
      nodes: [
        { id: 'start', kind: 'trigger', label: 'Big order', config: { event: 'Big Order' } },
        {
          id: 'tier',
          kind: 'transform',
          label: 'Tier',
          config: { set: 'tier', expression: 'event.properties.total > 1000 ? "gold" : "silver"' },
        },
        {
          id: 'notify',
          kind: 'action',
          label: 'Tell sales',
          config: { connection: slack, action, input: '{"text": "New " & vars.tier & " order: " & $string(event.properties.total)}' },
          next: [{ to: 'crm' }, { to: 'failed' }],
        },
        {
          id: 'crm',
          kind: 'webhook',
          label: 'Update CRM',
          config: { endpoint: hook, data: '{"profileId": profile.id, "tier": vars.tier, "total": event.properties.total}' },
          next: [{ to: 'done' }],
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
        { id: 'failed', kind: 'exit', label: 'Sales not told', config: {} },
      ],
    });
    journeyId = (await api.call('artifacts.create', { type: 'journey', name: 'Big orders', content: def('shout') })).artifactId;
    expect((await rejects(api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'x' }))).message).toContain(
      'slack has no action "shout"',
    );
    await api.call('artifacts.updateDraft', { artifactId: journeyId, content: def('postMessage') });

    const sim = await api.call('journeys.simulate', { artifactId: journeyId, actions: { notify: 'error' } });
    expect(sim.steps.map((s) => `${s.node}: ${s.detail}`)).toEqual([
      'start: ',
      'tier: would set vars.tier',
      'notify: error: given in the simulation',
      'failed: ',
    ]);
    await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'Go' });
  });

  it('runs the action, then sends the webhook; a failing action takes the error edge', async () => {
    const api = t.api(owner);
    await send([{ type: 'track', event: 'Big Order', userId: 'cy', properties: { total: 2500 } }]);
    const crm = await eventually(
      async () => at('/crm'),
      (r) => r.length === 1,
    );
    expect(JSON.parse(at('/slack')[0].body)).toEqual({ text: 'New gold order: 2500' });
    expect(JSON.parse(crm[0].body)).toMatchObject({
      type: 'journey.webhook',
      data: { journey: { id: journeyId, node: 'crm' }, tier: 'gold', total: 2500 },
    });

    script.set('/slack', [500, 500]);
    await send([{ type: 'track', event: 'Big Order', userId: 'dan', properties: { total: 300 } }]);
    await eventually(
      () => api.call('journeys.stats', { artifactId: journeyId }),
      (s) => (s.reached.failed ?? 0) === 1,
      15_000,
    );
    expect(at('/crm')).toHaveLength(1);
    const failed = (await api.call('deliveries.list', { targetId: slack, status: 'failed' })).deliveries;
    expect(failed[0]).toMatchObject({ kind: 'action', action: 'postMessage', attempts: 2 });
  });
});
