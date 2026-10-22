import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Wraps and unwraps data keys with a key-encryption key (KEK) that never touches the database.
 * Implementations: a local key from the environment (self-hosting), later AWS/GCP KMS or OpenBao.
 */
export interface KeyProvider {
  /** Identifies the current KEK, stored next to each wrapped key so rotation can find what to re-wrap. */
  readonly id: string;
  /** Wraps with the current KEK. */
  wrap(dataKey: Buffer): Promise<Buffer>;
  /** Unwraps with the KEK `kekId` names, which may be a previous one during a rotation. */
  unwrap(wrapped: Buffer, kekId: string): Promise<Buffer>;
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

function parseKek(base64: string) {
  const kek = Buffer.from(base64, 'base64');
  if (kek.length !== 32) throw new Error('MASTER_KEY must be 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`).');
  return kek;
}

/** A local KEK's id is a fingerprint of the key, so it changes exactly when the key does. */
const fingerprint = (kek: Buffer) => `local-${createHash('sha256').update(kek).digest('hex').slice(0, 12)}`;

/**
 * KEKs from base64-encoded 32-byte values, e.g. MASTER_KEY (current) and MASTER_KEY_PREVIOUS in the
 * environment. Rotation: set the new key as current and the old one as previous, run
 * `cli rotate-keys` to re-wrap every data key, then drop the previous key.
 */
export function localKeyProvider(current: string, previous: readonly string[] = []): KeyProvider {
  const keys = [current, ...previous].map(parseKek);
  const ids = keys.map(fingerprint);
  return {
    id: ids[0],
    async wrap(dataKey) {
      const s = seal(keys[0], dataKey);
      return Buffer.concat([s.iv, s.authTag, s.ciphertext]);
    },
    async unwrap(wrapped, kekId) {
      const sealed = { iv: wrapped.subarray(0, IV), authTag: wrapped.subarray(IV, IV + TAG), ciphertext: wrapped.subarray(IV + TAG) };
      // Try the named key first; GCM authentication rejects a wrong key, so trying the others is safe
      // and covers ids from before fingerprints were used.
      const order = [...keys.keys()].sort((a, b) => Number(ids[b] === kekId) - Number(ids[a] === kekId));
      for (const k of order) {
        try {
          return open(keys[k], sealed);
        } catch {}
      }
      throw new Error(`No configured master key unwraps this data key (kek ${kekId}). Is MASTER_KEY_PREVIOUS missing?`);
    },
  };
}

export const newDataKey = () => randomBytes(32);
