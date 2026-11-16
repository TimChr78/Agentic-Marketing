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
 * the survivor, and commits; topic-preference writes take it for the same reason; and a broadcast
 * batch takes it around "resolve the person, ask whether they already have this broadcast's
 * message, record the decision", so a merge either commits before the check or waits for the batch
 * (#944).
 *
 * Lock order, so nothing takes these two in the opposite order: a broadcast batch takes its run
 * row (`FOR UPDATE`) first, then this lock, then a send key (`lockSendKey`), then message rows. A
 * merge takes this lock first and never takes a run row or a send key; a direct send takes only a
 * send key. The broadcast is the only path that takes this lock and a send key, and it takes this
 * one first.
 */
export async function lockIdentity(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
}
