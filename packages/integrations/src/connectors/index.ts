import jsonata from 'jsonata';
import { z } from 'zod';
import { defineConnector, type InboundItem } from '../sdk';
import { verifyHmac, verifyWebhook } from '../signing';

// Built-in connectors. Shopify and Slack are references for the SDK; the generic webhook and
// HTTP connectors cover everything else (and n8n, Zapier or Make in front of it).

const asItems = (v: unknown): InboundItem[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x): x is InboundItem => !!x && typeof x === 'object');

export const webhookConnector = defineConnector({
  id: 'webhook',
  label: 'Incoming webhook',
  description:
    'Turns any JSON webhook into events with a JSONata mapping. Authenticated by the secret URL, and optionally by an HMAC signature or Standard Webhooks headers.',
  auth: 'signing_secret',
  settings: z.object({
    mapping: z
      .string()
      .min(1)
      .max(10_000)
      .default('body')
      .describe(
        'JSONata over {"body", "headers"} that returns one Segment event or an array, e.g. {"type":"track","event":"Lead Created","userId":body.id}',
      ),
    signature: z
      .object({
        scheme: z.enum(['hmac-sha256', 'standard-webhooks']),
        header: z.string().max(100).default('x-signature').describe('hmac-sha256: the header carrying the signature'),
        encoding: z.enum(['hex', 'base64']).default('hex'),
        prefix: z.string().max(20).default('').describe('e.g. "sha256=" for GitHub'),
      })
      .optional(),
  }),
  secrets: z.object({ signingSecret: z.string().min(1).max(500).optional() }),
  inbound: {
    verify({ settings, secrets, headers, body }) {
      const s = settings.signature;
      if (!s) return null;
      if (!secrets.signingSecret) return 'a signature is required but no signing secret is set';
      const ok =
        s.scheme === 'standard-webhooks'
          ? verifyWebhook(secrets.signingSecret, headers, body)
          : verifyHmac(secrets.signingSecret, body, headers[s.header.toLowerCase()], s.encoding, s.prefix);
      return ok ? null : 'the signature does not match';
    },
    async map(payload, { settings, headers }) {
      const v = await jsonata(settings.mapping).evaluate({ body: payload, headers });
      return asItems(v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    },
  },
});

const money = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));

export const shopifyConnector = defineConnector({
  id: 'shopify',
  label: 'Shopify',
  description:
    'Receives Shopify webhooks (orders/create, orders/paid, checkouts/create, customers/create, customers/update) as Order Completed, Checkout Started and identify events. Register the inbound URL in Shopify with the JSON format.',
  auth: 'signing_secret',
  settings: z.object({ shop: z.string().max(200).default('').describe('e.g. my-shop.myshopify.com (informational)') }),
  secrets: z.object({ webhookSecret: z.string().min(1).max(500).describe("The app's client secret, which signs its webhooks") }),
  inbound: {
    verify({ secrets, headers, body }) {
      return verifyHmac(secrets.webhookSecret, body, headers['x-shopify-hmac-sha256'], 'base64')
        ? null
        : 'the Shopify signature does not match';
    },
    map(payload, { headers }) {
      // biome-ignore lint/suspicious/noExplicitAny: Shopify's payloads, read defensively field by field
      const p = payload as Record<string, any>;
      const topic = headers['x-shopify-topic'] ?? '';
      const id = headers['x-shopify-webhook-id'] ?? headers['x-shopify-event-id'] ?? String(p.id ?? '');
      const at = p.updated_at ?? p.created_at;
      const customer = topic.startsWith('customers/') ? p : p.customer;
      const userId = customer?.id ? `shopify:${customer.id}` : undefined;
      const anonymousId = !userId && p.token ? `shopify-checkout:${p.token}` : undefined;
      const who = { ...(userId ? { userId } : { anonymousId }) };
      const items: InboundItem[] = [];
      if (customer?.id || p.email)
        items.push({
          type: 'identify',
          ...who,
          messageId: `${id}:identify`,
          timestamp: at,
          traits: {
            email: customer?.email ?? p.email,
            firstName: customer?.first_name,
            lastName: customer?.last_name,
            phone: customer?.phone ?? undefined,
            shopify_customer_id: customer?.id ? String(customer.id) : undefined,
            orders_count: customer?.orders_count,
          },
        });
      // biome-ignore lint/suspicious/noExplicitAny: as above
      const products = (p.line_items ?? []).map((l: Record<string, any>) => ({
        product_id: l.product_id ? String(l.product_id) : undefined,
        sku: l.sku ?? undefined,
        name: l.title,
        price: money(l.price),
        quantity: l.quantity,
      }));
      if (topic === 'orders/create' || topic === 'orders/paid')
        items.push({
          type: 'track',
          ...who,
          event: topic === 'orders/paid' ? 'Order Paid' : 'Order Completed',
          messageId: `${id}:order`,
          timestamp: at,
          properties: {
            order_id: String(p.id),
            order_number: p.order_number,
            total: money(p.total_price),
            subtotal: money(p.subtotal_price),
            tax: money(p.total_tax),
            discount: money(p.total_discounts),
            currency: p.currency,
            products,
          },
        });
      if (topic === 'checkouts/create')
        items.push({
          type: 'track',
          ...who,
          event: 'Checkout Started',
          messageId: `${id}:checkout`,
          timestamp: at,
          properties: { checkout_id: p.token, value: money(p.total_price), currency: p.currency, products },
        });
      return items;
    },
  },
});

export const slackConnector = defineConnector({
  id: 'slack',
  label: 'Slack',
  description: 'Posts messages to a Slack channel through an incoming webhook, e.g. to tell the sales team about a hot lead.',
  auth: 'api_key',
  settings: z.object({}),
  secrets: z.object({ webhookUrl: z.url().describe('https://hooks.slack.com/services/…') }),
  rateLimit: 60,
  actions: {
    postMessage: {
      label: 'Post a message',
      description: 'Send a text (Slack mrkdwn) to the channel of the incoming webhook.',
      input: z.object({ text: z.string().min(1).max(4000) }),
      async run(input: { text: string }, { secrets, request }) {
        const res = await request(secrets.webhookUrl, {
          body: JSON.stringify({ text: input.text }),
          headers: { 'content-type': 'application/json' },
        });
        if (res.status >= 300) throw new Error(`Slack answered ${res.status}: ${res.body.slice(0, 200)}`);
        return { posted: true };
      },
    },
  },
});

export const httpConnector = defineConnector({
  id: 'http',
  label: 'HTTP API',
  description: 'Calls a JSON API: a base URL with secret headers (e.g. Authorization), and requests from journey steps.',
  auth: 'api_key',
  settings: z.object({ baseUrl: z.url().describe('e.g. https://api.example.com/v2') }),
  secrets: z.object({ headers: z.record(z.string(), z.string().max(2000)).default({}).describe('e.g. {"Authorization": "Bearer …"}') }),
  rateLimit: 120,
  actions: {
    request: {
      label: 'HTTP request',
      description: 'A request to the base URL plus a path. JSON responses are parsed. Non-2xx answers take the error edge.',
      input: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
        path: z.string().max(1000).default(''),
        body: z.unknown().optional(),
      }),
      async run(input: { method: string; path: string; body?: unknown }, { settings, secrets, request }) {
        const url = `${settings.baseUrl.replace(/\/+$/, '')}/${input.path.replace(/^\/+/, '')}`;
        const res = await request(url, {
          method: input.method,
          headers: {
            accept: 'application/json',
            ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...secrets.headers,
          },
          body: input.body !== undefined && input.method !== 'GET' ? JSON.stringify(input.body) : undefined,
        });
        let body: unknown = res.body;
        try {
          body = JSON.parse(res.body);
        } catch {}
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        return { status: res.status, body };
      },
    },
  },
});

export const oauthHttpConnector = defineConnector({
  id: 'oauth_http',
  label: 'HTTP API (OAuth 2.0)',
  description:
    'Calls a JSON API that uses OAuth 2.0 (authorization code with PKCE): connect once in the browser, then tokens are refreshed automatically. Register <public URL>/oauth/callback as the redirect URI.',
  auth: 'oauth2',
  settings: z.object({
    baseUrl: z.url().describe('e.g. https://api.example.com/v2'),
    authorizeUrl: z.url(),
    tokenUrl: z.url(),
    scopes: z.array(z.string().max(300)).max(30).default([]),
    authorizeParams: z
      .record(z.string(), z.string().max(300))
      .default({})
      .describe('e.g. {"access_type":"offline","prompt":"consent"} for Google'),
  }),
  secrets: z.object({ clientId: z.string().min(1).max(500), clientSecret: z.string().min(1).max(500) }),
  oauth: (s) => ({ authorizeUrl: s.authorizeUrl, tokenUrl: s.tokenUrl, scopes: s.scopes, params: s.authorizeParams }),
  rateLimit: 120,
  actions: {
    request: {
      label: 'HTTP request',
      description:
        'A request to the base URL plus a path, with the access token. JSON responses are parsed. Non-2xx answers take the error edge.',
      input: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().max(1000).default(''),
        body: z.unknown().optional(),
      }),
      async run(input: { method: string; path: string; body?: unknown }, { settings, accessToken, request }) {
        if (!accessToken) throw new Error('not connected: authorize the connection first');
        const url = `${settings.baseUrl.replace(/\/+$/, '')}/${input.path.replace(/^\/+/, '')}`;
        const res = await request(url, {
          method: input.method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: input.body !== undefined && input.method !== 'GET' ? JSON.stringify(input.body) : undefined,
        });
        let body: unknown = res.body;
        try {
          body = JSON.parse(res.body);
        } catch {}
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        return { status: res.status, body };
      },
    },
  },
});

export const connectors = Object.fromEntries(
  [webhookConnector, shopifyConnector, slackConnector, httpConnector, oauthHttpConnector].map((c) => [c.id, c]),
) as Record<string, import('../sdk').Connector>;
