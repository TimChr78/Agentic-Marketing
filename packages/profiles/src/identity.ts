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
 * two orders cannot cross. It also precedes the per-person consent lock (`lockConsent` in
 * `consent.ts`), never the other way round: `resolve.ts` holds this lock while it records SDK
 * consent, and every consent writer takes only the consent lock.
 */
export async function lockIdentity(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
}
