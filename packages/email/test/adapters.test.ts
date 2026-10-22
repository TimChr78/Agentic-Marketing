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
