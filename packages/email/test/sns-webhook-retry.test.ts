import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adapters, SNS_CERT_FETCHES_PER_MINUTE, verifySnsMessage } from '../src/adapters';
import { webhookVerdict } from '../src/routes';

// SNS retries a webhook only for 429 and 5xx; a 401 is a permanent failure that drops the delivery
// event. Verification is therefore tri-state: `retry` for anything transient (rate limit, network,
// timeout, temporary certificate unavailability) and `invalid` only for a bad signature or host.

function snsFixture(n: number, keys?: { privateKey: KeyObject; publicKey: KeyObject }) {
  const { privateKey, publicKey } = keys ?? generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const url = `https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-retry-${n}.pem`;
  const m: Record<string, string> = {
    Type: 'Notification',
    MessageId: `sns-retry-${n}`,
    TopicArn: 'arn:aws:sns:eu-west-1:123:ses-events',
    Message: JSON.stringify({
      eventType: 'Delivery',
      mail: { messageId: 'ses-1' },
      delivery: { timestamp: '2026-10-22T10:00:00Z' },
    }),
    Timestamp: '2026-10-22T10:00:01Z',
    SignatureVersion: '2',
    SigningCertURL: url,
  };
  const sign = createSign('RSA-SHA256');
  sign.update(['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map((k) => `${k}\n${m[k]}\n`).join(''));
  m.Signature = sign.sign(privateKey, 'base64');
  return { m, pem, url };
}

describe('SNS verification is retryable (#807)', () => {
  it('a certificate fetch error is retry, and the route answers 503 with retry-after', async () => {
    const { m } = snsFixture(1);
    const deps = {
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof globalThis.fetch,
    };

    expect(await verifySnsMessage(m, deps)).toBe('retry');
    expect(webhookVerdict('retry')).toEqual({ status: 503, retryAfter: '60' });
  });

  it('a bad signature is still invalid, and the route answers 401', async () => {
    const good = snsFixture(2);
    const attacker = snsFixture(2); // same URL, another key
    const deps = { fetch: (async () => new Response(good.pem)) as typeof globalThis.fetch };

    expect(await verifySnsMessage(good.m, deps)).toBe('valid');
    expect(await verifySnsMessage(attacker.m, deps)).toBe('invalid');
    expect(webhookVerdict('invalid')).toEqual({ status: 401 });
  });

  it('past the process rate limit the route answers 503, not a permanent refusal', async () => {
    const limit = SNS_CERT_FETCHES_PER_MINUTE;
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fixtures = Array.from({ length: limit + 1 }, (_, i) => snsFixture(100 + i, keys));
    const pems = new Map(fixtures.map((f) => [f.url, f.pem]));
    const now = 1_000_000; // a fixed clock: every fetch stays inside one rolling minute
    const deps = {
      fetch: (async (url: string | URL | Request) => new Response(pems.get(String(url)) ?? '')) as typeof globalThis.fetch,
      now: () => now,
    };

    for (const f of fixtures.slice(0, limit)) expect(await verifySnsMessage(f.m, deps)).toBe('valid');
    const limited = fixtures[limit];

    // Through the SES transport, the same verdict the webhook route receives.
    const transport = adapters.ses.create(
      { region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLEEXAMPLE' },
      { secretAccessKey: 'secret-secret-secret-secret' },
      deps,
    );
    const verdict = await transport.verifyWebhook!({ headers: {}, body: JSON.stringify(limited.m) });
    expect(verdict).toBe('retry');
    expect(webhookVerdict(verdict!)).toEqual({ status: 503, retryAfter: '60' });
  });
});
