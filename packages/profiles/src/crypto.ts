import { createHmac } from 'node:crypto';
import { schema, type Tx } from '@agentic-marketing/db';
import { activeDataKey, dataKeyById, type KeyProvider, newDataKey, open, seal } from '@agentic-marketing/secrets';
import { and, eq, inArray } from 'drizzle-orm';

// Per-person encryption (crypto-shredding) and identifier matching. Keys are memoised for one
// transaction; nothing here is cached across requests.

const IV = 12;
const TAG = 16;
const pack = (s: { iv: Buffer; authTag: Buffer; ciphertext: Buffer }) => Buffer.concat([s.iv, s.authTag, s.ciphertext]);
const unpack = (b: Buffer) => ({ iv: b.subarray(0, IV), authTag: b.subarray(IV, IV + TAG), ciphertext: b.subarray(IV + TAG) });

export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const normalizePhone = (v: string) => {
  const digits = v.replace(/[^\d+]/g, '');
  return digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
};

export function personCrypto(tx: Tx, workspaceId: string, kp: KeyProvider) {
  let matching: Promise<Buffer> | undefined;
  const profileKeys = new Map<string, Promise<Buffer | null>>();

  async function loadProfileKey(profileId: string): Promise<Buffer | null> {
    const [k] = await tx
      .select()
      .from(schema.profileKeys)
      .where(and(eq(schema.profileKeys.workspaceId, workspaceId), eq(schema.profileKeys.profileId, profileId)));
    if (!k) return null;
    return open(await dataKeyById(tx, workspaceId, k.dataKeyId, kp), unpack(k.wrappedKey));
  }

  const c = {
    /** HMAC of a normalised e-mail or phone number: equal inputs match without storing plaintext. */
    async matchHash(type: 'email' | 'phone', value: string) {
      matching ??= activeDataKey(tx, workspaceId, kp, 'matching').then((k) => k.key);
      const norm = type === 'email' ? normalizeEmail(value) : normalizePhone(value);
      return createHmac('sha256', await matching)
        .update(`${type}:${norm}`)
        .digest('hex');
    },

    /** The profile's key, or null if it has none (no personal data yet, or erased). */
    profileKey(profileId: string) {
      if (!profileKeys.has(profileId)) profileKeys.set(profileId, loadProfileKey(profileId));
      return profileKeys.get(profileId) as Promise<Buffer | null>;
    },

    async ensureProfileKey(profileId: string): Promise<Buffer> {
      const existing = await c.profileKey(profileId);
      if (existing) return existing;
      const dk = await activeDataKey(tx, workspaceId, kp, 'identity');
      const key = newDataKey();
      await tx.insert(schema.profileKeys).values({ workspaceId, profileId, dataKeyId: dk.id, wrappedKey: pack(seal(dk.key, key)) });
      profileKeys.set(profileId, Promise.resolve(key));
      return key;
    },

    async seal(profileId: string, value: unknown): Promise<Buffer> {
      return pack(seal(await c.ensureProfileKey(profileId), Buffer.from(JSON.stringify(value), 'utf8')));
    },

    /** Decrypts with the profile key; undefined when the key is gone (erased) or there is nothing. */
    async open<T>(profileId: string, sealed: Buffer | null): Promise<T | undefined> {
      if (!sealed) return undefined;
      const key = await c.profileKey(profileId);
      return key ? (JSON.parse(open(key, unpack(sealed)).toString('utf8')) as T) : undefined;
    },

    /**
     * Opens a page of sealed values with two queries (the profile keys, then their data keys),
     * not one run of open() per person. Used by profiles.list, which returns up to 200 rows.
     */
    async openMany<T>(items: { profileId: string; sealed: Buffer }[]): Promise<(T | undefined)[]> {
      if (!items.length) return [];
      const ids = [...new Set(items.map((i) => i.profileId))];
      const keys = await tx
        .select()
        .from(schema.profileKeys)
        .where(and(eq(schema.profileKeys.workspaceId, workspaceId), inArray(schema.profileKeys.profileId, ids)));
      const dataKeyIds = [...new Set(keys.map((k) => k.dataKeyId))];
      const wrapped = dataKeyIds.length
        ? await tx
            .select()
            .from(schema.dataKeys)
            .where(and(eq(schema.dataKeys.workspaceId, workspaceId), inArray(schema.dataKeys.id, dataKeyIds)))
        : [];
      const dataKeys = new Map(await Promise.all(wrapped.map(async (k) => [k.id, await kp.unwrap(k.wrappedKey, k.kekId)] as const)));
      // Unwrap each person's key once, here, then use it for every value of theirs on the page.
      const keyOf = new Map(
        keys.flatMap((k) => {
          const dataKey = dataKeys.get(k.dataKeyId);
          return dataKey ? [[k.profileId, open(dataKey, unpack(k.wrappedKey))] as const] : [];
        }),
      );
      return items.map(({ profileId, sealed }) => {
        const key = keyOf.get(profileId);
        return key ? (JSON.parse(open(key, unpack(sealed)).toString('utf8')) as T) : undefined;
      });
    },
  };
  return c;
}
export type PersonCrypto = ReturnType<typeof personCrypto>;
