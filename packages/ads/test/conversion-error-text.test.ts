import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Conversion,
  googleAdsConnector,
  metaAdsConnector,
  metaAudienceError,
  type Person,
  pinterestAdsConnector,
  sendToGoogle,
  sendToMeta,
  sendToPinterest,
  sendToTiktok,
  tiktokAdsConnector,
} from '../src';

// #885 round 6: an ad platform's failure is stored in the conversion queue, shown to the person and
// copied into a command's error, so its credential-bearing text must be redacted before it is cut.
// The probe is the same everywhere: a credential the platform echoes, and (for the JSON fallback) a
// token that straddles the cut, which only survives if the text was cut first.
const SECRET = 'probe-secret';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

let reply: { status: number; body: unknown } = { status: 500, body: {} };
let base = '';
const server = createServer((_req, res) => {
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const egress = { allowedHosts: ['127.0.0.1'] };
const conversion: Conversion = { eventId: 'e1', name: 'Lead', at: new Date().toISOString(), profileId: 'prf_1' };
const person: Person = { email: 'ada@example.com', phone: null, clickIds: {}, personalization: false };

describe('Meta and Google conversion failures (#885)', () => {
  it('redacts Meta’s own error message', async () => {
    reply = { status: 400, body: { error: { message: `bad request: access_token=${SECRET}` } } };
    const r = await sendToMeta(
      conversion,
      person,
      { eventName: 'Lead' },
      metaAdsConnector.settings.parse({ pixelId: '12345678', apiBase: base }),
      { accessToken: 'x'.repeat(30) },
      egress,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).toContain('HTTP 400');
  });

  it('redacts Google’s own error message', async () => {
    reply = { status: 403, body: { error: { message: `refused: password=${SECRET}` } } };
    const r = await sendToGoogle(
      conversion,
      person,
      { conversionAction: '1' },
      googleAdsConnector.settings.parse({ customerId: '1234567890', apiBase: base }),
      'token',
      egress,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('redacts the JSON fallback before cutting it', async () => {
    // The token starts 30 characters before the 300-character cut, so cutting first leaves it a
    // fragment too short for any token rule to see.
    reply = { status: 500, body: JSON.stringify({ detail: `${' '.repeat(240)}${TOKEN}` }) };
    const r = await sendToMeta(
      conversion,
      person,
      { eventName: 'Lead' },
      metaAdsConnector.settings.parse({ pixelId: '12345678', apiBase: base }),
      { accessToken: 'x'.repeat(30) },
      egress,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('a1b2c3d4e5f60718');
  });
});

describe('TikTok and Pinterest conversion failures (#885)', () => {
  it('redacts TikTok’s HTTP-200 error code message', async () => {
    reply = { status: 200, body: { code: 40001, message: `bad request: access_token=${SECRET}` } };
    const r = await sendToTiktok(
      conversion,
      person,
      { event: 'Lead' },
      tiktokAdsConnector.settings.parse({ pixelCode: 'ABCDEF1234', apiBase: base }),
      { accessToken: 'x'.repeat(30) },
      egress,
    );
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(JSON.stringify(r)).toContain('TikTok code 40001');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('redacts a Pinterest failed-event message', async () => {
    reply = { status: 200, body: { events: [{ status: 'failed', error_message: `bad event: password=${SECRET}` }] } };
    const r = await sendToPinterest(
      conversion,
      person,
      { eventName: 'Lead' },
      pinterestAdsConnector.settings.parse({ adAccountId: '1234567', apiBase: base }),
      { accessToken: 'x'.repeat(30) },
      egress,
    );
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(JSON.stringify(r)).toContain('Pinterest:');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('Meta audience failures (#885)', () => {
  it('keeps the Ads Manager guidance when “flagged” sits past the cut', () => {
    // The flag word is beyond the 300-character diagnostic, so it must be looked for in the full
    // body; the guidance is the part a person needs.
    const body = JSON.stringify({ error: { message: `${'x'.repeat(400)} the audience was flagged` } });
    const error = metaAudienceError(400, body);
    expect(error).toContain('flagged by Meta');
    expect(error).toContain('Ads Manager');
    expect(error.length).toBeLessThan(400);
  });

  it('adds no guidance when the audience is not flagged', () => {
    expect(metaAudienceError(400, JSON.stringify({ error: { message: 'bad request' } }))).toBe('HTTP 400: bad request');
  });
});
