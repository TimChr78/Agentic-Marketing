import { createHmac } from 'node:crypto';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { SubjectKeyHasher, SubjectKeyHasherFactory, SubjectKeyKind } from '@agentic-marketing/events';
import { activeDataKey, type KeyProvider } from '@agentic-marketing/secrets';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeEmail, normalizePhone } from './crypto';

// The exclusion key (#1037). A workspace-scoped HMAC key for erasure subject values, separate from
// the matching key and never sent to ClickHouse. Its purpose is `exclusion`, so `am rotate-keys`
// (which only re-wraps a data key with the KEK) does not change it, and rotating the matching key
// leaves every subject hash valid.
//
// It is long-lived. A deliberate rotation is only for compromise: mint a new key for new writes and
// new erasures, but keep the old wrapped key indefinitely, because ledger HMACs cannot be
// recomputed once the subject's crypto-shredded plaintext is gone. Reads match against every
// retained key version; a compromised key exposes pseudonymous linkage of hashed identifiers and
// cannot be revoked.

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
 * The workspace's active exclusion key. If none is active but the ledger references one, that key
 * wins (it is the only one whose hashes match the ledger) and is activated. If ledger rows exist
 * and the referenced key is missing, refuse rather than create a second key whose hashes would
 * never match: no silent divergence.
 */
export async function ensureExclusionKey(tx: Tx, workspaceId: string, kp: KeyProvider): Promise<{ id: string; key: Buffer }> {
  const [active] = await tx
    .select()
    .from(schema.dataKeys)
    .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.active, true), eq(schema.dataKeys.purpose, 'exclusion')));
  if (active) return { id: active.id, key: await kp.unwrap(active.wrappedKey, active.kekId) };

  const referenced = await tx
    .select()
    .from(schema.dataKeys)
    .where(
      and(
        eq(schema.dataKeys.workspaceId, workspaceId),
        eq(schema.dataKeys.purpose, 'exclusion'),
        sql`EXISTS (SELECT 1 FROM erasure_keys k WHERE k.workspace_id = ${workspaceId} AND k.key_version = ${schema.dataKeys.id})`,
      ),
    )
    .orderBy(sql`${schema.dataKeys.createdAt} DESC`)
    .limit(1);
  const winner = referenced[0];
  if (winner) {
    await tx
      .update(schema.dataKeys)
      .set({ active: false })
      .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.active, true), eq(schema.dataKeys.purpose, 'exclusion')));
    await tx
      .update(schema.dataKeys)
      .set({ active: true })
      .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.id, winner.id)));
    return { id: winner.id, key: await kp.unwrap(winner.wrappedKey, winner.kekId) };
  }

  const ledger = await tx.execute(sql`SELECT 1 FROM erasure_keys WHERE workspace_id = ${workspaceId} LIMIT 1`);
  if (ledger.rows.length)
    throw new Error(
      'the exclusion key referenced by this workspace’s erasure ledger is missing; restore it (or the backup) instead of creating a second key, whose hashes would never match',
    );
  return activeDataKey(tx, workspaceId, kp, 'exclusion');
}

/**
 * Resolves (and, only for a workspace with no ledger rows, creates) the active exclusion key before
 * a protected transaction is prepared. Called from the erasure command and the startup pass.
 */
export async function prepareExclusionKey(db: Pick<Db, 'withWorkspace'>, workspaceId: string, kp: KeyProvider): Promise<void> {
  await db.withWorkspace(workspaceId, (tx) => ensureExclusionKey(tx, workspaceId, kp));
}

/** Provision the exclusion key for every workspace that does not have one yet. */
export async function ensureExclusionKeys(deps: { db: Pick<Db, 'admin' | 'withWorkspace'>; kp: KeyProvider }): Promise<number> {
  const { rows } = await deps.db.admin.query<{ id: string }>('SELECT id FROM workspaces');
  for (const row of rows) await deps.db.withWorkspace(row.id, (tx) => ensureExclusionKey(tx, row.id, deps.kp));
  return rows.length;
}

/**
 * The active exclusion key, for a caller already inside a transaction with prepared keys (the
 * erasure stage). It must not be used where a KEK call would happen under a protected lock.
 */
export async function exclusionHasher(tx: Tx, workspaceId: string, kp: KeyProvider): Promise<ExclusionHasher> {
  const { id, key } = await ensureExclusionKey(tx, workspaceId, kp);
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
    const { id, key } = await deps.db.withWorkspace(workspaceId, (tx) => ensureExclusionKey(tx, workspaceId, deps.kp));
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
