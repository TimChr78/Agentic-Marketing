import { AppError, newId } from '@agentic-marketing/core';
import { type Db, enqueueErasureCleanupJob, schema, type Tx } from '@agentic-marketing/db';
import { type KeyProvider, newDataKey, open, type PreparedKeys, prepareKeys, seal } from '@agentic-marketing/secrets';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { mergedFamily } from './consent';
import { personCrypto } from './crypto';
import { lockProfileRows, withIdentityLock } from './identity';

// Durable erasure (#978 part 2b). The SQL stage and the external stores used to be mixed in one
// transaction, so a ClickHouse or Valkey wait kept the transaction open and a merge could slip in
// between resolving the family and deleting it. Now one short transaction resolves the family and
// removes every SQL row, writes the tombstones and records a cleanup job; the scheduler deletes
// the ClickHouse events and the hot state afterwards (packages/profiles/src/erasureCleanup.ts).

const IV = 12;
const TAG = 16;
const pack = (s: { iv: Buffer; authTag: Buffer; ciphertext: Buffer }) => Buffer.concat([s.iv, s.authTag, s.ciphertext]);
const unpack = (b: Buffer) => ({ iv: b.subarray(0, IV), authTag: b.subarray(IV, IV + TAG), ciphertext: b.subarray(IV + TAG) });

/** The anonymous and user ids a cleanup needs to find the person's events and hot-state keys. */
export interface ErasureSelectors {
  anonymousIds: string[];
  userIds: string[];
}

/**
 * Everything the SQL stage needs that must be prepared before its transaction: the matching key
 * for tombstone hashes, and a per-erasure service key for the selectors. The service key is
 * random and only wrapped by the configured KEK; the person's own key, which the same transaction
 * destroys, never protects the selectors.
 */
export interface PreparedErasure {
  matching: PreparedKeys;
  selectorKey: Buffer;
  wrappedSelectorKey: Buffer;
  selectorKek: string;
}

/** Prepares the keys an erasure needs. Runs before the command's transaction. */
export async function prepareErasure(db: Pick<Db, 'withWorkspace'>, workspaceId: string, kp: KeyProvider): Promise<PreparedErasure> {
  const matching = await prepareKeys(db, workspaceId, kp, { purposes: ['matching'] });
  try {
    const selectorKey = newDataKey();
    const wrappedSelectorKey = await kp.wrap(selectorKey);
    return { matching, selectorKey, wrappedSelectorKey, selectorKek: kp.id };
  } catch (error) {
    matching.provider.dispose();
    throw error;
  }
}

/** Zeroes the prepared copies after the handler's transaction has settled. */
export function disposeErasure(prepared: PreparedErasure): void {
  prepared.matching.provider.dispose();
  prepared.selectorKey.fill(0);
}

/** The selectors, sealed with the per-erasure service key. */
export function sealSelectors(key: Buffer, selectors: ErasureSelectors): Buffer {
  return pack(seal(key, Buffer.from(JSON.stringify(selectors), 'utf8')));
}

/** Opens sealed selectors. A malformed payload is an error, never an empty cleanup. */
export function openSelectors(key: Buffer, sealed: Buffer): ErasureSelectors {
  const parsed = JSON.parse(open(key, unpack(sealed)).toString('utf8')) as Partial<ErasureSelectors>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))] : [];
  return { anonymousIds: strings(parsed.anonymousIds), userIds: strings(parsed.userIds) };
}

/**
 * Removes the person's SQL rows. The external deletes are not here any more: the erasure's job
 * owns them, so this runs entirely inside one transaction with no network I/O.
 */
export async function removeProfiles(
  tx: Tx,
  workspaceId: string,
  family: string[],
  identifiers: (typeof schema.identifiers.$inferSelect)[],
  opts: { suppress: boolean },
) {
  // Profile rows before the participant rows this deletes, the shared order (identity.ts). A score
  // finalisation (#1011 review) or a journey step takes the same profile lock first, so neither can
  // hold a participant row this deletion wants while waiting for a profile row it holds.
  await lockProfileRows(tx, workspaceId, family, { includeMerged: true });
  const anonymousIds = identifiers.filter((i) => i.type === 'anonymous_id').map((i) => i.value);
  const userIds = identifiers.filter((i) => i.type === 'user_id').map((i) => i.value);
  if (anonymousIds.length) await tx.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.anonymousId, anonymousIds));
  if (userIds.length) await tx.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, userIds));
  await tx.delete(schema.messages).where(inArray(schema.messages.profileId, family));
  // Out of every journey: no later step runs, and the participant's context (the trigger event) goes too.
  await tx.delete(schema.journeyParticipants).where(inArray(schema.journeyParticipants.profileId, family));
  // The journey hook's per-event markers are the person's too: an event id is caller-supplied and can
  // name them, and a marker sitting on a merged-away id comes with the family (#1011 review).
  await tx.delete(schema.journeyProcessedEvents).where(inArray(schema.journeyProcessedEvents.profileId, family));
  // Out of every segment's materialised membership; static list rows cascade with the profile below.
  await tx.delete(schema.segmentMemberships).where(inArray(schema.segmentMemberships.profileId, family));
  const suppress = opts.suppress ? identifiers.filter((i) => i.type === 'email' || i.type === 'phone') : [];
  if (suppress.length)
    await tx
      .insert(schema.suppressions)
      .values(
        suppress.map((i) => ({
          workspaceId,
          channel: i.type === 'email' ? ('email' as const) : ('sms' as const),
          valueHash: i.value,
          reason: 'erased' as const,
        })),
      )
      .onConflictDoNothing();
  const consent = await tx
    .delete(schema.consentRecords)
    .where(inArray(schema.consentRecords.profileId, family))
    .returning({ id: schema.consentRecords.id });
  await tx.delete(schema.profileMerges).where(inArray(schema.profileMerges.fromId, family));
  await tx.delete(schema.profileMerges).where(inArray(schema.profileMerges.intoId, family));
  // Cascades to identifiers, profile keys (crypto-shredding), consent state and decision scores.
  await tx.delete(schema.profiles).where(inArray(schema.profiles.id, family));
  return {
    profiles: family.length,
    identifiers: identifiers.length,
    consentRecords: consent.length,
    anonymousIds,
    userIds,
  };
}

export interface ErasureStageInput {
  workspaceId: string;
  profileId: string;
  requestedBy: string;
  reason: string;
  prepared: PreparedErasure;
}

export interface ErasureStageResult {
  erasureId: string;
  counts: { profiles: number; identifiers: number; consentRecords: number };
  status: 'pending';
  profileIds: string[];
}

/**
 * The one SQL stage of an erasure: canonical profile and complete merged family, tombstones,
 * suppression hashes, SQL deletion, the erasure record and its cleanup job. No network I/O.
 *
 * The whole stage runs under the workspace identity lock, taken before the canonical profile is
 * looked up: a merge that committed first is included in the family, and a merge that starts after
 * this transaction commits sees the profile is gone. The external cleanup is a durable job, so the
 * lock covers SQL rows only.
 */
export async function eraseProfileStage(tx: Tx, input: ErasureStageInput): Promise<ErasureStageResult> {
  return withIdentityLock(tx, input.workspaceId, () => eraseProfileStageLocked(tx, input));
}

async function eraseProfileStageLocked(tx: Tx, input: ErasureStageInput): Promise<ErasureStageResult> {
  const { workspaceId, prepared } = input;
  let id = input.profileId;
  let found = false;
  for (let i = 0; i < 20; i++) {
    const [p] = await tx
      .select({ id: schema.profiles.id, mergedInto: schema.profiles.mergedInto })
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, id)));
    if (!p) break;
    if (!p.mergedInto) {
      id = p.id;
      found = true;
      break;
    }
    id = p.mergedInto;
  }
  if (!found) throw new AppError('not_found', `No profile ${input.profileId}. Find people with profiles.find or profiles.list.`);

  const family = await mergedFamily(tx, workspaceId, id);
  const identifiers = await tx
    .select()
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.workspaceId, workspaceId), inArray(schema.identifiers.profileId, family)));

  const erasureId = newId('era');
  // Tombstones first, while the values are still in memory: keyed hashes (never raw values) let the
  // resolver drop events that were queued or arrive late (#210). The matching key came prepared.
  if (identifiers.length) {
    const crypto = personCrypto(tx, workspaceId, prepared.matching.provider);
    const hashes = [...new Set(await Promise.all(identifiers.map((i) => crypto.tombstoneHash(i.type, i.value))))];
    await tx
      .insert(schema.erasureTombstones)
      .values(hashes.map((identHash) => ({ workspaceId, identHash, erasedAt: sql`now()`, erasureId })))
      .onConflictDoUpdate({
        target: [schema.erasureTombstones.workspaceId, schema.erasureTombstones.identHash],
        set: { erasedAt: sql`now()`, erasureId },
      });
  }

  const selectors: ErasureSelectors = {
    anonymousIds: identifiers.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
    userIds: identifiers.filter((i) => i.type === 'user_id').map((i) => i.value),
  };
  const sealed = sealSelectors(prepared.selectorKey, selectors);

  const removed = await removeProfiles(tx, workspaceId, family, identifiers, { suppress: true });
  const counts = { profiles: removed.profiles, identifiers: removed.identifiers, consentRecords: removed.consentRecords };
  await tx
    .insert(schema.erasures)
    .values({ workspaceId, id: erasureId, profileIds: family, requestedBy: input.requestedBy, reason: input.reason, counts });
  await enqueueErasureCleanupJob(tx, workspaceId, {
    erasureId,
    profileIds: family,
    selectors: sealed,
    selectorKey: prepared.wrappedSelectorKey,
    selectorKek: prepared.selectorKek,
  });
  return { erasureId, counts, status: 'pending', profileIds: family };
}
