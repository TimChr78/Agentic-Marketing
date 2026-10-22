import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Wraps and unwraps data keys with a key-encryption key (KEK) that never touches the database.
 * Implementations: a local key from the environment (self-hosting), later AWS/GCP KMS or OpenBao.
 */
export interface KeyProvider {
  /** Identifies the KEK, stored next to each wrapped key so rotation can find what to re-wrap. */
  readonly id: string;
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

const IV = 12;
const TAG = 16;

export function seal(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ciphertext, authTag: c.getAuthTag() };
}

export function open(key: Buffer, sealed: { iv: Buffer; ciphertext: Buffer; authTag: Buffer }) {
  const d = createDecipheriv('aes-256-gcm', key, sealed.iv);
  d.setAuthTag(sealed.authTag);
  return Buffer.concat([d.update(sealed.ciphertext), d.final()]);
}

/** KEK from a base64-encoded 32-byte value, e.g. MASTER_KEY in the environment. */
export function localKeyProvider(masterKeyBase64: string, id = 'local-1'): KeyProvider {
  const kek = Buffer.from(masterKeyBase64, 'base64');
  if (kek.length !== 32) throw new Error('MASTER_KEY must be 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`).');
  return {
    id,
    async wrap(dataKey) {
      const s = seal(kek, dataKey);
      return Buffer.concat([s.iv, s.authTag, s.ciphertext]);
    },
    async unwrap(wrapped) {
      return open(kek, { iv: wrapped.subarray(0, IV), authTag: wrapped.subarray(IV, IV + TAG), ciphertext: wrapped.subarray(IV + TAG) });
    },
  };
}

export const newDataKey = () => randomBytes(32);
