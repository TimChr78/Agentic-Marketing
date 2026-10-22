import { describe, expect, it } from 'vitest';
import {
  googleAdsConnector,
  googleEmail,
  googlePhone,
  metaAdsConnector,
  metaEmail,
  metaPhone,
  sendToGoogle,
  sendToMeta,
  sha256,
} from '../src';

const egress = { allowedHosts: ['127.0.0.1'] };

describe('hashing', () => {
  it('normalises like each platform before hashing', () => {
    expect(metaEmail(' Ada@Example.COM ')).toBe(sha256('ada@example.com'));
    expect(metaPhone('+45 12 34 56 78')).toBe(sha256('4512345678'));
    expect(googleEmail('A.da.Lovelace@gmail.com')).toBe(sha256('adalovelace@gmail.com'));
    expect(googleEmail('a.da@example.com')).toBe(sha256('a.da@example.com'));
    expect(googlePhone('+45 12 34 56 78')).toBe(sha256('+4512345678'));
  });
});

describe('request shapes', () => {
  it('refuses Meta events older than 7 days without calling Meta', async () => {
    const r = await sendToMeta(
      { eventId: 'e1', name: 'X', at: new Date(Date.now() - 8 * 86_400_000).toISOString(), profileId: 'prf_1' },
      { email: null, phone: null, clickIds: {}, personalization: false },
      { eventName: 'Lead' },
      metaAdsConnector.settings.parse({ pixelId: '12345678' }),
      { accessToken: 'x'.repeat(30) },
      egress,
    );
    expect(r).toMatchObject({ ok: false, permanent: true });
  });

  it('refuses a Google conversion with nothing to match on, and without a token', async () => {
    const settings = googleAdsConnector.settings.parse({ customerId: '1234567890' });
    const c = { eventId: 'e1', name: 'X', at: new Date().toISOString(), profileId: 'prf_1' };
    const nobody = { email: null, phone: null, clickIds: {}, personalization: false };
    expect(await sendToGoogle(c, nobody, { conversionAction: '1' }, settings, 'token', egress)).toMatchObject({
      ok: false,
      error: expect.stringContaining('nothing to match on'),
    });
    expect(await sendToGoogle(c, { ...nobody, email: 'a@b.c' }, { conversionAction: '1' }, settings, undefined, egress)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected'),
    });
  });
});
