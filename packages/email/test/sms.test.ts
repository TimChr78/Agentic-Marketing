import { describe, expect, it } from 'vitest';
import { smsSegments, twilioSignature } from '../src';
import { smsAdapters } from '../src/sms/adapters';

const config = smsAdapters.twilio.config.parse({ accountSid: `AC${'a'.repeat(32)}` });
const secrets = { authToken: 'twilio-auth-token-123' };

describe('Twilio', () => {
  it('sends a text with a status callback and reads the segments', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sid: 'SM1', num_segments: '2', status: 'queued' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const t = smsAdapters.twilio.create(config, secrets, { fetch });
    const r = await t.send({
      messageId: 'msg_1',
      to: '+4512345678',
      from: 'Signal',
      body: 'Hi',
      statusUrl: 'https://am.example.com/hooks/sms/x/status',
    });
    expect(r).toEqual({ providerMessageId: 'SM1', segments: 2 });
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({
      To: '+4512345678',
      From: 'Signal',
      Body: 'Hi',
      StatusCallback: 'https://am.example.com/hooks/sms/x/status',
    });
  });

  it('verifies the request signature over URL and parameters', () => {
    const t = smsAdapters.twilio.create(config, secrets, { fetch });
    const url = 'https://am.example.com/hooks/sms/tok/inbound';
    const params = { From: '+4512345678', Body: 'STOP', MessageSid: 'SM2' };
    const body = new URLSearchParams(params).toString();
    const sig = twilioSignature(secrets.authToken, url, params);
    expect(t.verifyWebhook({ url, body, headers: { 'x-twilio-signature': sig } })).toBe(true);
    expect(t.verifyWebhook({ url, body: body.replace('STOP', 'START'), headers: { 'x-twilio-signature': sig } })).toBe(false);
    expect(t.verifyWebhook({ url, body, headers: {} })).toBe(false);
    expect(t.parseInbound({ url, body, headers: {} })).toEqual({ from: '+4512345678', body: 'STOP' });
    expect(t.reply('Help & info').body).toContain('<Message>Help &amp; info</Message>');
  });

  it('maps delivery statuses, with unreachable numbers as hard bounces', () => {
    const t = smsAdapters.twilio.create(config, secrets, { fetch });
    const status = (p: Record<string, string>) => t.parseStatus({ url: '', headers: {}, body: new URLSearchParams(p).toString() });
    expect(status({ MessageSid: 'SM1', MessageStatus: 'delivered' })).toMatchObject([{ type: 'delivered', providerMessageId: 'SM1' }]);
    expect(status({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' })).toMatchObject([
      { type: 'bounced', bounce: 'hard' },
    ]);
    expect(status({ MessageSid: 'SM1', MessageStatus: 'failed', ErrorCode: '30001' })).toMatchObject([{ type: 'bounced', bounce: 'soft' }]);
    expect(status({ MessageSid: 'SM1', MessageStatus: 'sent' })).toEqual([]);
  });
});

describe('segments', () => {
  it('counts GSM-7 and UCS-2 like carriers', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', length: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('€'.repeat(80))).toEqual({ encoding: 'GSM-7', length: 160, segments: 1 });
    expect(smsSegments('Hej Søren, æblerne er klar')).toMatchObject({ encoding: 'GSM-7' });
    expect(smsSegments(`${'a'.repeat(69)}🙂`)).toEqual({ encoding: 'UCS-2', length: 71, segments: 2 });
  });
});
