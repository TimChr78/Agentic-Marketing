import { CONSENT_EVENT } from '@agentic-marketing/events';
import { z } from 'zod';
import { defineConnector, type InboundItem } from '../sdk';
import { verifyHmac } from '../signing';

// Shopify. Two ways in:
//   shopify      webhooks only: register the inbound URL in Shopify yourself (any plan, any app)
//   shopify_app  your Shopify app, installed with OAuth: the webhooks are registered for you
//                (shopify.registerWebhooks) and existing customers can be imported
//                (shopify.importCustomers), with their e-mail marketing consent if you choose
// Both turn orders, checkouts, fulfilments, refunds and customers into the same events. They only
// read the shop: nothing here changes orders, products or customers.

// biome-ignore lint/suspicious/noExplicitAny: Shopify's payloads, read defensively field by field
type Payload = Record<string, any>;

const money = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const numericId = (gid: unknown) => String(gid ?? '').replace(/^gid:\/\/shopify\/\w+\//, '');

export const shopifySettings = z.object({
  shop: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'The shop domain, e.g. my-shop.myshopify.com')
    .or(z.literal(''))
    .default(''),
  syncEmailConsent: z
    .boolean()
    .default(false)
    .describe(
      "Record Shopify's e-mail marketing consent (subscribed / unsubscribed) as marketing_email consent, with Shopify as the proof. Turn on only if consent in your shop was collected for this purpose.",
    ),
});
type ShopifySettings = z.output<typeof shopifySettings>;

/** The events for one customer (REST webhook shape, or GraphQL with the same field names mapped). */
export function customerItems(
  c: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    ordersCount?: number;
    consent?: { state?: string; optInLevel?: string | null; updatedAt?: string | null } | null;
  },
  opts: { messageId: string; at?: string; settings: ShopifySettings },
): InboundItem[] {
  const userId = `shopify:${c.id}`;
  const items: InboundItem[] = [
    {
      type: 'identify',
      userId,
      messageId: `${opts.messageId}:identify`,
      ...(opts.at ? { timestamp: opts.at } : {}),
      traits: {
        email: c.email ?? undefined,
        firstName: c.firstName ?? undefined,
        lastName: c.lastName ?? undefined,
        phone: c.phone ?? undefined,
        shopify_customer_id: c.id,
        orders_count: c.ordersCount,
      },
    },
  ];
  const state = c.consent?.state?.toLowerCase();
  if (opts.settings.syncEmailConsent && c.email && (state === 'subscribed' || state === 'unsubscribed'))
    items.push({
      type: 'track',
      event: CONSENT_EVENT,
      userId,
      messageId: `${opts.messageId}:consent:${state}:${c.consent?.updatedAt ?? ''}`,
      ...(c.consent?.updatedAt ? { timestamp: c.consent.updatedAt } : opts.at ? { timestamp: opts.at } : {}),
      properties: { source: 'shopify', opt_in_level: c.consent?.optInLevel ?? undefined },
      context: { consent: { categoryPreferences: { marketing_email: state === 'subscribed' } } },
    });
  return items;
}

const ORDER_EVENTS: Record<string, string> = {
  'orders/create': 'Order Completed',
  'orders/paid': 'Order Paid',
  'orders/fulfilled': 'Order Shipped',
  'orders/cancelled': 'Order Cancelled',
};

/** Shopify webhook payloads as events. */
export function shopifyItems(p: Payload, headers: Record<string, string | undefined>, settings: ShopifySettings): InboundItem[] {
  const topic = headers['x-shopify-topic'] ?? '';
  const id = headers['x-shopify-webhook-id'] ?? headers['x-shopify-event-id'] ?? String(p.id ?? '');
  const at = p.updated_at ?? p.created_at;
  const customer = topic.startsWith('customers/') ? p : p.customer;
  const userId = customer?.id ? `shopify:${customer.id}` : undefined;
  const anonymousId = !userId && p.token ? `shopify-checkout:${p.token}` : undefined;
  const who = { ...(userId ? { userId } : { anonymousId }) };
  const items: InboundItem[] = [];
  if (customer?.id)
    items.push(
      ...customerItems(
        {
          id: String(customer.id),
          email: customer.email ?? p.email,
          firstName: customer.first_name,
          lastName: customer.last_name,
          phone: customer.phone,
          ordersCount: customer.orders_count,
          consent: customer.email_marketing_consent
            ? {
                state: customer.email_marketing_consent.state,
                optInLevel: customer.email_marketing_consent.opt_in_level,
                updatedAt: customer.email_marketing_consent.consent_updated_at,
              }
            : null,
        },
        { messageId: id, at, settings },
      ),
    );
  else if (p.email) items.push({ type: 'identify', ...who, messageId: `${id}:identify`, timestamp: at, traits: { email: p.email } });
  const products = (p.line_items ?? []).map((l: Payload) => ({
    product_id: l.product_id ? String(l.product_id) : undefined,
    sku: l.sku ?? undefined,
    name: l.title,
    price: money(l.price),
    quantity: l.quantity,
  }));
  if (ORDER_EVENTS[topic])
    items.push({
      type: 'track',
      ...who,
      event: ORDER_EVENTS[topic],
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
        ...(topic === 'orders/cancelled' ? { reason: p.cancel_reason ?? undefined } : {}),
      },
    });
  if (topic === 'refunds/create') {
    const refunded = (p.transactions ?? []).reduce((n: number, t: Payload) => n + (money(t.amount) ?? 0), 0);
    items.push({
      type: 'track',
      ...(p.customer?.id ? { userId: `shopify:${p.customer.id}` } : { anonymousId: `shopify-order:${p.order_id}` }),
      event: 'Order Refunded',
      messageId: `${id}:refund`,
      timestamp: p.created_at,
      properties: { order_id: String(p.order_id), total: refunded || undefined, currency: p.transactions?.[0]?.currency },
    });
  }
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
}

const TOPICS = [
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
  'refunds/create',
  'checkouts/create',
  'customers/create',
  'customers/update',
];

export const shopifyConnector = defineConnector({
  id: 'shopify',
  label: 'Shopify',
  description: `Receives Shopify webhooks (${TOPICS.join(', ')}) as Order Completed, Order Paid, Order Shipped, Order Cancelled, Order Refunded, Checkout Started and identify events. Register the inbound URL in Shopify with the JSON format, or use the Shopify app connector to have them registered for you.`,
  auth: 'signing_secret',
  settings: shopifySettings,
  secrets: z.object({ webhookSecret: z.string().min(1).max(500).describe("The app's client secret, which signs its webhooks") }),
  inbound: {
    verify({ secrets, headers, body }) {
      return verifyHmac(secrets.webhookSecret, body, headers['x-shopify-hmac-sha256'], 'base64')
        ? null
        : 'the Shopify signature does not match';
    },
    map: (payload, { headers, settings }) => shopifyItems(payload as Payload, headers, settings),
  },
});

const appSettings = shopifySettings.extend({
  shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'The shop domain, e.g. my-shop.myshopify.com'),
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2025-10'),
  apiBase: z.url().optional().describe('Override for tests; default https://<shop>'),
});
const adminBase = (s: z.output<typeof appSettings>) => (s.apiBase ?? `https://${s.shop}`).replace(/\/$/, '');

/** One Admin GraphQL call; GraphQL errors and userErrors become exceptions. */
export async function shopifyGraphql(
  s: z.output<typeof appSettings>,
  accessToken: string | undefined,
  request: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; body: string }>,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Payload> {
  if (!accessToken) throw new Error('not connected: install the app (connections.authorize)');
  const res = await request(`${adminBase(s)}/admin/api/${s.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
    body: JSON.stringify({ query, variables }),
  });
  let b: Payload = {};
  try {
    b = JSON.parse(res.body);
  } catch {}
  if (res.status < 200 || res.status >= 300) throw new Error(`Shopify answered ${res.status}: ${res.body.slice(0, 200)}`);
  if (b.errors?.length) throw new Error(`Shopify: ${b.errors.map((e: Payload) => e.message).join('; ')}`);
  return b.data ?? {};
}

export const CUSTOMERS_QUERY = `query Customers($after: String) {
  customers(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id email firstName lastName phone numberOfOrders updatedAt
      emailMarketingConsent { marketingState marketingOptInLevel consentUpdatedAt }
    }
  }
}`;

/** GraphQL customers as events (ids as in webhooks: the numeric part of the gid). */
export const graphqlCustomerItems = (n: Payload, settings: ShopifySettings) =>
  customerItems(
    {
      id: numericId(n.id),
      email: n.email,
      firstName: n.firstName,
      lastName: n.lastName,
      phone: n.phone,
      ordersCount: n.numberOfOrders === undefined ? undefined : Number(n.numberOfOrders),
      consent: n.emailMarketingConsent
        ? {
            state: n.emailMarketingConsent.marketingState,
            optInLevel: n.emailMarketingConsent.marketingOptInLevel?.toLowerCase(),
            updatedAt: n.emailMarketingConsent.consentUpdatedAt,
          }
        : null,
    },
    { messageId: `shopify-import:${numericId(n.id)}:${n.updatedAt ?? ''}`, at: n.updatedAt, settings },
  );

export const shopifyAppConnector = defineConnector({
  id: 'shopify_app',
  label: 'Shopify (app install)',
  description:
    'Your Shopify app, installed in the shop with OAuth (read_customers, read_orders). Receives the same webhooks as the Shopify connector; registerWebhooks subscribes them for you, and shopify.importCustomers brings in existing customers. Set the app URL and <public URL>/oauth/callback as redirect URL in the Shopify Partner dashboard.',
  auth: 'oauth2',
  settings: appSettings,
  secrets: z.object({
    clientId: z.string().min(1).max(500).describe("The app's client id (API key)"),
    clientSecret: z.string().min(1).max(500).describe("The app's client secret; it also signs webhooks"),
  }),
  oauth: (s) => ({
    authorizeUrl: `${adminBase(s)}/admin/oauth/authorize`,
    tokenUrl: `${adminBase(s)}/admin/oauth/access_token`,
    scopes: ['read_customers', 'read_orders'],
  }),
  rateLimit: 120,
  inbound: {
    verify({ secrets, headers, body }) {
      return verifyHmac(secrets.clientSecret, body, headers['x-shopify-hmac-sha256'], 'base64')
        ? null
        : 'the Shopify signature does not match';
    },
    map: (payload, { headers, settings }) => shopifyItems(payload as Payload, headers, settings),
  },
  actions: {
    registerWebhooks: {
      label: 'Register webhooks',
      description: `Subscribes the shop's ${TOPICS.join(', ')} webhooks to this connection's inbound URL (shown once when the connection was created). Topics already subscribed are reported, not duplicated.`,
      input: z.object({ inboundUrl: z.url().describe("This connection's inbound URL") }),
      async run(input: { inboundUrl: string }, { settings, accessToken, request }) {
        const done: string[] = [];
        const existing: string[] = [];
        for (const topic of TOPICS) {
          const data = await shopifyGraphql(
            settings,
            accessToken,
            request,
            `mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
              webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
                webhookSubscription { id }
                userErrors { field message }
              }
            }`,
            { topic: topic.toUpperCase().replace('/', '_'), sub: { uri: input.inboundUrl, format: 'JSON' } },
          );
          const errors = (data.webhookSubscriptionCreate?.userErrors ?? []) as { message: string }[];
          if (errors.some((e) => /already been taken|already exists/i.test(e.message))) existing.push(topic);
          else if (errors.length) throw new Error(`${topic}: ${errors.map((e) => e.message).join('; ')}`);
          else done.push(topic);
        }
        return { subscribed: done, alreadySubscribed: existing };
      },
    },
  },
});
