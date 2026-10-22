import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (https://www.standardwebhooks.com): webhook-id, webhook-timestamp and
// webhook-signature "v1,<base64 HMAC-SHA256 of id.timestamp.body>", with a "whsec_" secret.
// Receivers (n8n, Svix libraries, a few lines of code) verify with the same secret.

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64')}`;

const keyOf = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function webhookHeaders(secret: string, id: string, body: string, now = Date.now()): Record<string, string> {
  const ts = Math.floor(now / 1000);
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': signWebhook(secret, id, ts, body),
  };
}

/** Verifies Standard Webhooks headers (tolerance: 5 minutes). */
export function verifyWebhook(secret: string, headers: Record<string, string | undefined>, body: string, now = Date.now()): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigs = headers['webhook-signature'];
  if (!id || !ts || !sigs || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = Buffer.from(signWebhook(secret, id, ts, body));
  return sigs.split(' ').some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

/** HMAC of a raw body in hex or base64 (how Shopify, GitHub and many others sign), compared in constant time. */
export function verifyHmac(secret: string, body: string, signature: string | undefined, encoding: 'hex' | 'base64', prefix = ''): boolean {
  if (!signature?.startsWith(prefix)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest(encoding));
  const got = Buffer.from(signature.slice(prefix.length));
  return got.length === expected.length && timingSafeEqual(got, expected);
}
