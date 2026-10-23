import { createECDH, createPublicKey, verify } from 'node:crypto';
// @ts-expect-error http_ece ships no types; it is an independent RFC 8188 implementation used to check ours.
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import { b64url, encryptPayload, vapidAuthorization, vapidKeys } from '../src/push/crypto';

// Web push encryption checked against an independent implementation (http_ece decrypts what we
// encrypt), and VAPID JWTs checked with the public key.

describe('web push crypto', () => {
  it('encrypts a payload that a browser (http_ece) can decrypt', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const body = encryptPayload(Buffer.from('{"title":"Hej"}'), { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) });
    const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, dh: undefined, authSecret: auth });
    expect(plain.toString()).toBe('{"title":"Hej"}');
  });

  it('signs VAPID JWTs for the push service origin', () => {
    const keys = vapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.com', 1_700_000_000_000);
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });
});
