import { createSign, generateKeyPairSync } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { afterAll, describe, expect, it } from 'vitest';
import { adapters, type OutgoingEmail, parseBrevoWebhook, parsePostmarkWebhook, sesEvents, verifySnsMessage } from '../src/adapters';

const msg: OutgoingEmail = {
  messageId: 'msg_0192abc',
  from: { email: 'news@shop.example.com', name: 'Fjeldvej' },
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  headers: { 'List-Unsubscribe': '<https://m.example.com/u/t>' },
  stream: 'marketing',
};

function stubFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url instanceof Request ? url.url : url), init: init ?? {} });
    if (url instanceof Request)
      calls[calls.length - 1].init = { method: url.method, headers: Object.fromEntries(url.headers), body: await url.text() };
    return new Response(JSON.stringify(response), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('Postmark', () => {
  it('sends to the right stream with our id as metadata', async () => {
    const s = stubFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    const t = adapters.postmark.create(adapters.postmark.config.parse({}), { serverToken: 'server-token-x' }, s);
    expect(await t.send(msg)).toEqual({ providerMessageId: 'pm-1' });
    const body = JSON.parse(String(s.calls[0].init.body));
    expect(body).toMatchObject({
      MessageStream: 'broadcast',
      Metadata: { am_message_id: 'msg_0192abc' },
      From: '"Fjeldvej" <news@shop.example.com>',
      TrackOpens: false,
      TrackLinks: 'None',
    });
    expect(body.Headers).toEqual([{ Name: 'List-Unsubscribe', Value: '<https://m.example.com/u/t>' }]);
  });

  it('reports refusals as errors', async () => {
    const s = stubFetch({ ErrorCode: 406, Message: 'Inactive recipient' }, 422);
    const t = adapters.postmark.create(adapters.postmark.config.parse({}), { serverToken: 'server-token-x' }, s);
    await expect(t.send(msg)).rejects.toThrow('Inactive recipient');
  });

  it('parses bounces, complaints and clicks', async () => {
    const p = (b: unknown) => parsePostmarkWebhook({ headers: {}, body: JSON.stringify(b) });
    expect(
      await p({
        RecordType: 'Bounce',
        ID: 42,
        Type: 'HardBounce',
        Description: 'Unknown user',
        MessageID: 'pm-1',
        BouncedAt: '2026-10-22T10:00:00Z',
        Metadata: { am_message_id: 'msg_1' },
      }),
    ).toEqual([
      {
        eventId: 'pm-1:Bounce:42',
        type: 'bounced',
        bounce: 'hard',
        reason: 'HardBounce: Unknown user',
        messageId: 'msg_1',
        providerMessageId: 'pm-1',
        at: '2026-10-22T10:00:00Z',
      },
    ]);
    expect((await p({ RecordType: 'Bounce', ID: 43, Type: 'SoftBounce', MessageID: 'pm-1', BouncedAt: 'x' }))[0].bounce).toBe('soft');
    expect((await p({ RecordType: 'SpamComplaint', ID: 44, MessageID: 'pm-1', BouncedAt: 'x' }))[0].type).toBe('complained');
    expect((await p({ RecordType: 'Click', MessageID: 'pm-1', ReceivedAt: 'x', OriginalLink: 'https://shop/x' }))[0]).toMatchObject({
      type: 'clicked',
      url: 'https://shop/x',
    });
  });
});

describe('Adapter tracking metadata', () => {
  it('declares a tracking capability and a note for every adapter', () => {
    for (const a of Object.values(adapters)) {
      expect(['forced', 'configurable', 'none']).toContain(a.tracking);
      expect(a.trackingNote.length).toBeGreaterThan(10);
    }
    expect(adapters.brevo.tracking).toBe('forced');
    expect(adapters.postmark.tracking).toBe('configurable');
  });
});

describe('Brevo', () => {
  it('sends with our id in X-Mailin-custom and maps webhook events back', async () => {
    const s = stubFetch({ messageId: '<b-1@smtp-relay.mailin.fr>' }, 201);
    const t = adapters.brevo.create({}, { apiKey: 'xkeysib-123456' }, s);
    expect(await t.send(msg)).toEqual({ providerMessageId: '<b-1@smtp-relay.mailin.fr>' });
    expect(JSON.parse(String(s.calls[0].init.body)).headers['X-Mailin-custom']).toBe('am:msg_0192abc');
    expect(s.calls[0].init.headers).toMatchObject({ 'api-key': 'xkeysib-123456' });
    const events = await parseBrevoWebhook({
      headers: {},
      body: JSON.stringify({
        event: 'hard_bounce',
        'message-id': '<b-1>',
        'X-Mailin-custom': 'am:msg_0192abc',
        ts_event: 1792650000,
        reason: 'mailbox unavailable',
      }),
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'bounced', bounce: 'hard', messageId: 'msg_0192abc', reason: 'mailbox unavailable' }),
    ]);
    expect(await parseBrevoWebhook({ headers: {}, body: JSON.stringify({ event: 'request' }) })).toEqual([]);
  });
});

describe('Amazon SES', () => {
  it('signs SendEmail with SigV4 and tags our id', async () => {
    const s = stubFetch({ MessageId: 'ses-1' });
    const t = adapters.ses.create(
      { region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLEEXAMPLE', configurationSet: 'events' },
      { secretAccessKey: 'secret-secret-secret-secret' },
      s,
    );
    expect(await t.send(msg)).toEqual({ providerMessageId: 'ses-1' });
    expect(s.calls[0].url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    expect(String((s.calls[0].init.headers as Record<string, string>).authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request/,
    );
    const body = JSON.parse(String(s.calls[0].init.body));
    expect(body).toMatchObject({ ConfigurationSetName: 'events', EmailTags: [{ Name: 'am_message_id', Value: 'msg_0192abc' }] });
  });

  it('verifies SNS signatures and rejects tampering or foreign certificate hosts', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const deps = { fetch: (async () => new Response(pem)) as typeof fetch };
    const m: Record<string, string> = {
      Type: 'Notification',
      MessageId: 'sns-1',
      TopicArn: 'arn:aws:sns:eu-west-1:123:ses-events',
      Message: JSON.stringify({
        eventType: 'Complaint',
        mail: { messageId: 'ses-1', tags: { am_message_id: ['msg_1'] } },
        complaint: { feedbackId: 'f1', timestamp: '2026-10-22T10:00:00Z' },
      }),
      Timestamp: '2026-10-22T10:00:01Z',
      SignatureVersion: '2',
      SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem',
    };
    const sign = createSign('RSA-SHA256');
    sign.update(['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map((k) => `${k}\n${m[k]}\n`).join(''));
    m.Signature = sign.sign(privateKey, 'base64');
    expect(await verifySnsMessage(m, deps)).toBe(true);
    expect(await verifySnsMessage({ ...m, Message: m.Message.replace('Complaint', 'Delivery') }, deps)).toBe(false);
    expect(await verifySnsMessage({ ...m, SigningCertURL: 'https://evil.example.com/cert.pem' }, deps)).toBe(false);
    expect(sesEvents(JSON.parse(m.Message))).toEqual([
      expect.objectContaining({ type: 'complained', messageId: 'msg_1', providerMessageId: 'ses-1' }),
    ]);
    expect(
      sesEvents({
        eventType: 'Bounce',
        mail: { messageId: 'ses-2' },
        bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', feedbackId: 'f2' },
      })[0],
    ).toMatchObject({ bounce: 'soft' });
  });
});

// #634: the signing-certificate cache stored the *promise*, keyed by URL, with no `.catch()` and no
// eviction. One timeout or 5xx poisoned that URL for the life of the process, so every later SNS
// bounce/complaint webhook was rejected with 401. Only a successful fetch may be cached.
describe('SNS certificate cache (#634)', () => {
  const certUrl = (n: number) => `https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-cache-${n}.pem`;

  /** A correctly signed Notification, plus the PEM that verifies it. */
  function snsFixture(url: string) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const m: Record<string, string> = {
      Type: 'Notification',
      MessageId: `sns-${url.slice(-9)}`,
      TopicArn: 'arn:aws:sns:eu-west-1:123:ses-events',
      Message: JSON.stringify({
        eventType: 'Complaint',
        mail: { messageId: 'ses-1' },
        complaint: { feedbackId: 'f1', timestamp: '2026-10-22T10:00:00Z' },
      }),
      Timestamp: '2026-10-22T10:00:01Z',
      SignatureVersion: '2',
      SigningCertURL: url,
    };
    const sign = createSign('RSA-SHA256');
    sign.update(['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map((k) => `${k}\n${m[k]}\n`).join(''));
    m.Signature = sign.sign(privateKey, 'base64');
    return { m, pem };
  }

  it('caches only a successful fetch: one timeout does not disable the next webhook', async () => {
    const { m, pem } = snsFixture(certUrl(1));
    let calls = 0;
    const fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error('socket hang up');
      return new Response(pem);
    }) as typeof globalThis.fetch;

    expect(await verifySnsMessage(m, { fetch })).toBe(false);
    expect(await verifySnsMessage(m, { fetch })).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not cache a non-OK certificate response', async () => {
    const { m, pem } = snsFixture(certUrl(2));
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return calls === 1 ? new Response('<html>service unavailable</html>', { status: 503 }) : new Response(pem);
    }) as typeof globalThis.fetch;

    expect(await verifySnsMessage(m, { fetch })).toBe(false);
    expect(await verifySnsMessage(m, { fetch })).toBe(true);
    expect(calls).toBe(2);
  });

  it('refetches once when a cached certificate no longer verifies', async () => {
    const good = snsFixture(certUrl(3));
    const attacker = snsFixture(certUrl(3));
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(good.pem);
    }) as typeof globalThis.fetch;

    expect(await verifySnsMessage(good.m, { fetch })).toBe(true);
    // Different key, same URL: the cached certificate fails, so it is fetched again before the
    // signature is refused.
    expect(await verifySnsMessage(attacker.m, { fetch })).toBe(false);
    expect(calls).toBe(2);
  });

  it('refetches at most once per certificate URL per 60 seconds', async () => {
    const good = snsFixture(certUrl(4));
    const attacker = snsFixture(certUrl(4));
    let calls = 0;
    let now = 1_000_000;
    const deps = {
      fetch: (async () => {
        calls++;
        return new Response(good.pem);
      }) as typeof globalThis.fetch,
      now: () => now,
    };

    expect(await verifySnsMessage(good.m, deps)).toBe(true); // the initial fetch
    for (let i = 0; i < 5; i++) expect(await verifySnsMessage(attacker.m, deps)).toBe(false);
    // One refetch for the first bad signature; the next four stay inside the cooldown.
    expect(calls).toBe(2);
    now += 60_001;
    expect(await verifySnsMessage(attacker.m, deps)).toBe(false);
    expect(calls).toBe(3);
  });

  it('refuses a cache-miss fetch for a URL that is still in cooldown (#755)', async () => {
    const url = certUrl(90);
    const good = snsFixture(url);
    const attacker = snsFixture(url); // same URL, another key: the cached PEM fails to verify
    let calls = 0;
    const now = 1_000_000;
    const deps = {
      fetch: (async () => {
        calls++;
        return new Response(good.pem);
      }) as typeof globalThis.fetch,
      now: () => now,
    };

    expect(await verifySnsMessage(good.m, deps)).toBe(true); // the initial fetch
    expect(await verifySnsMessage(attacker.m, deps)).toBe(false); // one forced refetch starts the cooldown
    expect(calls).toBe(2);

    // Certificates are per AWS region: more distinct URLs than the cache holds evict this one, and
    // SigningCertURL is not part of the signature, so the same fixture verifies against every
    // churned URL.
    for (let i = 0; i < 70; i++) expect(await verifySnsMessage({ ...good.m, SigningCertURL: certUrl(200 + i) }, deps)).toBe(true);
    const afterChurn = calls;

    // The cached PEM is gone, but the URL is still inside its refetch cooldown. A miss must not
    // turn into a fetch (the old code fetched first and only then consulted the throttle).
    expect(await verifySnsMessage(attacker.m, deps)).toBe(false);
    expect(await verifySnsMessage(good.m, deps)).toBe(false);
    expect(calls).toBe(afterChurn);
  });

  it('bounds a cycle of more certificate URLs than the cache holds (#755)', async () => {
    const urls = Array.from({ length: 65 }, (_, i) => certUrl(300 + i));
    const fixtures = urls.map((url) => snsFixture(url));
    const pems = new Map(fixtures.map((f) => [f.m.SigningCertURL, f.pem]));
    let calls = 0;
    const now = 1_000_000;
    const deps = {
      fetch: (async (url: string | URL | Request) => {
        calls++;
        return new Response(pems.get(String(url)) ?? '');
      }) as typeof globalThis.fetch,
      now: () => now,
    };

    // The attack: more distinct certificate URLs than the 64-entry cache holds, cycled twice. The
    // first pass fetches each URL once; the second must not fetch the evicted ones again.
    for (const f of fixtures) expect(await verifySnsMessage(f.m, deps)).toBe(true);
    expect(calls).toBe(65);
    const second = [];
    for (const f of fixtures) second.push(await verifySnsMessage(f.m, deps));
    expect(calls).toBe(65);
    // The 64 still cached verify; only the evicted first URL is refused (SNS retries later).
    expect(second[0]).toBe(false);
    expect(second.filter(Boolean)).toHaveLength(64);
  });

  it('coalesces concurrent fetches for the same certificate URL into one request', async () => {
    const { m, pem } = snsFixture(certUrl(5));
    let calls = 0;
    const deps = {
      fetch: (async () => {
        calls++;
        return new Response(pem);
      }) as typeof globalThis.fetch,
    };
    expect(await Promise.all([verifySnsMessage(m, deps), verifySnsMessage(m, deps)])).toEqual([true, true]);
    expect(calls).toBe(1);
  });
});

describe('SMTP', () => {
  const received: { from: string; to: string[]; data: string }[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let data = '';
      stream.on('data', (c) => (data += c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          data,
        });
        cb();
      });
    },
    onRcptTo(address, _s, cb) {
      cb(address.address.endsWith('@nowhere.invalid') ? new Error('550 no such user') : undefined);
    },
  });
  const port = 2526;
  const ready = new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('delivers through a relay with our headers, and surfaces rejections', async () => {
    await ready;
    const t = adapters.smtp.create(adapters.smtp.config.parse({ host: '127.0.0.1', port, requireTls: false }), {}, { fetch });
    const out = await t.send(msg);
    expect(out.providerMessageId).toMatch(/@/);
    expect(received[0]).toMatchObject({ from: 'news@shop.example.com', to: ['ada@example.com'] });
    expect(received[0].data).toMatch(/^X-Mailin-custom: am:msg_0192abc$/im);
    expect(received[0].data).toContain('List-Unsubscribe: <https://m.example.com/u/t>');
    try {
      await expect(t.send({ ...msg, to: 'x@nowhere.invalid' })).rejects.toThrow();
    } finally {
      await t.close?.();
    }
  });
});

describe('Cloudflare Email Service', () => {
  const config = adapters.cloudflare.config.parse({ accountId: 'a'.repeat(32) });
  const secrets = { apiToken: 'cf-token-0123456789abcdef' };

  it('sends through the REST API and reports delivery from the response', async () => {
    const s = stubFetch({
      success: true,
      errors: [],
      result: { message_id: 'cf-1', delivered: ['ada@example.com'], queued: [], permanent_bounces: [], suppressed_recipients: [] },
    });
    const r = await adapters.cloudflare.create(config, secrets, s).send(msg);
    expect(r).toMatchObject({ providerMessageId: 'cf-1', events: [{ type: 'delivered', messageId: 'msg_0192abc' }] });
    expect(s.calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`);
    expect((s.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer cf-token-0123456789abcdef');
    expect(JSON.parse(String(s.calls[0].init.body))).toMatchObject({
      from: { address: 'news@shop.example.com', name: 'Fjeldvej' },
      to: 'ada@example.com',
      headers: { 'List-Unsubscribe': '<https://m.example.com/u/t>' },
    });
  });

  it('turns permanent bounces and suppressed recipients into hard bounces', async () => {
    const bounced = stubFetch({ success: true, result: { message_id: 'cf-2', permanent_bounces: ['ADA@example.com'] } });
    expect((await adapters.cloudflare.create(config, secrets, bounced).send(msg)).events).toMatchObject([
      { type: 'bounced', bounce: 'hard' },
    ]);
    const suppressed = stubFetch({ success: true, result: { message_id: 'cf-3', suppressed_recipients: ['ada@example.com'] } });
    expect((await adapters.cloudflare.create(config, secrets, suppressed).send(msg)).events).toMatchObject([
      { type: 'bounced', reason: "on Cloudflare's suppression list" },
    ]);
  });

  it('reports refusals as errors', async () => {
    const s = stubFetch({ success: false, errors: [{ code: 10001, message: 'sender domain not verified' }] }, 400);
    await expect(adapters.cloudflare.create(config, secrets, s).send(msg)).rejects.toThrow('sender domain not verified');
  });
});
