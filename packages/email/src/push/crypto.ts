import { createCipheriv, createECDH, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// The cryptography push needs, on node:crypto alone:
//   - VAPID (RFC 8292): an ES256 JWT that identifies the sender to browser push services;
//   - message encryption for web push (RFC 8291, aes128gcm content coding of RFC 8188), so the
//     push service relays a payload it cannot read;
//   - ES256 and RS256 JWTs for APNs provider tokens and Google service accounts.

export const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

/** A P-256 key pair for VAPID: the public key raw (65 bytes, uncompressed) and the private scalar, base64url. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(pub.x as string), fromB64url(pub.y as string)])),
    privateKey: priv.d as string,
  };
}

function ecPrivateKey(publicKey: string, privateKey: string) {
  const raw = fromB64url(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('the VAPID public key is not an uncompressed P-256 point');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
    format: 'jwk',
  });
}

/** A JWT signed with ES256 (JOSE signature format: r || s). */
export function es256Jwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: Parameters<typeof sign>[2]) {
  const input = `${b64url(JSON.stringify({ alg: 'ES256', ...header }))}.${b64url(JSON.stringify(claims))}`;
  const sig = sign('sha256', Buffer.from(input), { key: key as never, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/** A JWT signed with RS256 (Google service accounts). */
export function rs256Jwt(claims: Record<string, unknown>, privateKeyPem: string, keyId?: string) {
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(keyId ? { kid: keyId } : {}) }))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(createSign('RSA-SHA256').update(input).sign(privateKeyPem))}`;
}

/** The Authorization header for one push service origin, valid for 12 hours. */
export function vapidAuthorization(endpoint: string, keys: { publicKey: string; privateKey: string }, subject: string, now = Date.now()) {
  const jwt = es256Jwt(
    { typ: 'JWT' },
    { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject },
    ecPrivateKey(keys.publicKey, keys.privateKey),
  );
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/**
 * Encrypts a payload for one browser subscription (RFC 8291): a fresh ECDH key and salt per
 * message, one record (RFC 8188) with the padding delimiter 0x02.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: { p256dh: string; auth: string },
  ephemeral?: { privateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('the subscription keys are not valid');
  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(ephemeral.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = ephemeral?.salt ?? randomBytes(16);

  // HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  // Header: salt (16) | record size (4) | key id length (1) | key id (the sender's public key).
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Largest payload a push service must accept (4096-byte record, minus header, tag and delimiter). */
export const MAX_PAYLOAD = 4096 - 86 - 16 - 1;
