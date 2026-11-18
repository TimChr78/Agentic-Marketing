import { createHmac } from 'node:crypto';
import type { Db, Tx } from '@agentic-marketing/db';
import type { SubjectKeyHasher, SubjectKeyHasherFactory, SubjectKeyKind } from '@agentic-marketing/events';
import { activeDataKey, type KeyProvider } from '@agentic-marketing/secrets';
import { normalizeEmail, normalizePhone } from './crypto';

// The exclusion key (#1037). A workspace-scoped HMAC key for erasure subject values, separate from
// the matching key and never sent to ClickHouse. Its purpose is `exclusion`, so `am rotate-keys`
// (which only re-wraps a data key with the KEK) does not change it, and rotating the matching key
// leaves every subject hash valid. A deliberate re-key means a new exclusion data key, recomputing
// the ledger and the backfill while both versions stay accepted.

/**
 * The value a kind is hashed as. E-mail and phone use the same normalisation as matching (lower
 * case/trim, digits); ids and click ids are opaque and are used exactly as stored.
 */
export function normalizeSubjectValue(kind: SubjectKeyKind, value: string): string {
  if (kind === 'email') return normalizeEmail(value);
  if (kind === 'phone') return normalizePhone(value);
  return value;
}

/** Domain-separated HMAC under the exclusion key. The kind is part of the message, not the key. */
export function exclusionHash(key: Buffer, kind: SubjectKeyKind, value: string): string {
  return createHmac('sha256', key)
    .update(`exclusion:${kind}:${normalizeSubjectValue(kind, value)}`)
    .digest('hex');
}

export interface ExclusionHasher {
  readonly version: string;
  hash(kind: SubjectKeyKind, value: string): string;
}

/**
 * The active exclusion key, for a caller already inside a transaction with prepared keys (the
 * erasure stage). It must not be used where a KEK call would happen under a protected lock.
 */
export async function exclusionHasher(tx: Tx, workspaceId: string, kp: KeyProvider): Promise<ExclusionHasher> {
  const { id, key } = await activeDataKey(tx, workspaceId, kp, 'exclusion');
  return { version: id, hash: (kind, value) => exclusionHash(key, kind, value) };
}

/**
 * The event store's subject-key hasher (#1037). Resolves the workspace exclusion key once per
 * batch, returns HMAC_exclusion for every identifier kind, and zeroes its own copy afterwards.
 * Errors are never swallowed: a row whose keys could not be computed must fail the write so the
 * sink redelivers instead of being stored marked complete.
 */
export function subjectKeyHasher(deps: { db: Pick<Db, 'withWorkspace'>; kp: KeyProvider }): SubjectKeyHasherFactory {
  return async (workspaceId: string): Promise<SubjectKeyHasher> => {
    const { id, key } = await deps.db.withWorkspace(workspaceId, (tx) => activeDataKey(tx, workspaceId, deps.kp, 'exclusion'));
    // The provider may hand out a shared cached buffer; this owner must not zero that.
    const own: Buffer = Buffer.from(key);
    let disposed = false;
    return {
      version: id,
      async hash(kind, value) {
        if (disposed) throw new Error('the exclusion key hasher was disposed');
        return exclusionHash(own, kind, value);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        own.fill(0);
      },
    };
  };
}
