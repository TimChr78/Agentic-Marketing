import type { Db } from '@agentic-marketing/db';
import type { BusEvent, SubjectKeyHashes, SubjectKeyResolver } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { personCrypto } from './crypto';

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/**
 * Computes the keyed e-mail/phone subject hashes for stored events (#1037 part 1). The sink hands
 * `BusEvent` to the store while its PII traits are still in memory; this resolver turns them into
 * the workspace matching key's HMAC and returns the hash plus the data key id (`key_version`), so
 * the plaintext never reaches ClickHouse. It runs before the insert and returns one entry per
 * event, in order; events without an e-mail or phone trait get null.
 *
 * A key-provider failure must not stop event storage: the ids are still written, and only the two
 * hash columns stay empty for that batch.
 */
export function subjectKeyResolver(deps: { db: Pick<Db, 'withWorkspace'>; kp: KeyProvider }): SubjectKeyResolver {
  return async (events) => {
    const hashes: (SubjectKeyHashes | null)[] = events.map(() => null);
    const byWorkspace = new Map<string, number[]>();
    events.forEach((event, index) => {
      if (!text(event.piiTraits.email) && !text(event.piiTraits.phone)) return;
      byWorkspace.set(event.workspaceId, [...(byWorkspace.get(event.workspaceId) ?? []), index]);
    });
    if (!byWorkspace.size) return hashes;

    for (const [workspaceId, indexes] of byWorkspace) {
      try {
        await deps.db.withWorkspace(workspaceId, async (tx) => {
          const crypto = personCrypto(tx, workspaceId, deps.kp);
          // Provision/read the matching key once for the batch; it is also the recorded version.
          const version = await crypto.matchingKeyId();
          const computed = new Map<string, Promise<string>>();
          const hashOf = (type: 'email' | 'phone', value: string) => {
            const cacheKey = `${type}\u0000${value}`;
            let pending = computed.get(cacheKey);
            if (!pending) {
              pending = crypto.matchHash(type, value);
              computed.set(cacheKey, pending);
            }
            return pending;
          };
          for (const index of indexes) {
            const event = events[index] as BusEvent;
            const email = text(event.piiTraits.email);
            const phone = text(event.piiTraits.phone);
            hashes[index] = {
              emailHash: email ? await hashOf('email', email) : '',
              phoneHash: phone ? await hashOf('phone', phone) : '',
              version,
            };
          }
        });
      } catch (err) {
        // The batch is still stored with its ids; only the keyed hashes are missing.
        logger.warn({ err }, 'subject key hashes were not computed for a stored event batch');
      }
    }
    return hashes;
  };
}
