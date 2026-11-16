import type { Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';

/**
 * The identity lock: one transaction-scoped advisory lock per workspace, held by every write that
 * must not interleave with an identity merge.
 *
 * Granularity is the workspace, not the profile, because a merge is decided from the identifiers
 * that point at an arbitrary set of profiles; a per-profile key would have to be taken for both
 * sides of every pair and could not be ordered for a chain. Identity resolution takes it in
 * `applyEvents` before it rewrites a profile id, moves that person's messages and participants to
 * the survivor, and commits, and topic-preference writes take it so an old signed link cannot
 * recreate a choice on a merged-away profile.
 *
 * Order: this lock precedes the row writes of the transaction that takes it. Nothing that takes it
 * also takes a broadcast run row or a send key (`lockSendKey`), and no send takes it at all, so the
 * two orders cannot cross.
 *
 * Every consent writer takes this lock first, before it resolves a canonical profile, and holds it
 * through the consent-ledger insert and the `consent_state` rebuild (`recordConsentEvidence` and
 * `recordConsent` in `consent.ts`). A delivery batch takes it once at the start of the batch
 * transaction, before it touches any message or suppression row. So the order is always
 * **identity lock first, then message/suppression rows (and the consent ledger), never the other
 * way round**. That serialises consent writes with each other and with merges; there is no
 * per-profile consent lock to order against.
 */
export async function lockIdentity(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
}
