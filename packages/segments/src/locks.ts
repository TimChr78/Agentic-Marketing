import type { Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';

// Serialising the writers of one segment's membership (#1104).
//
// `segment_memberships` has one row per person. A full refresh, the incremental update an event
// batch runs, and the list commands all insert and delete rows for the same people, and PostgreSQL
// waits on the unique index one row at a time: two writers that touch the same people in different
// orders each hold a row the other wants, and the server kills one as a deadlock (40P01, answered
// as a retryable 409). A transaction-scoped advisory lock per segment makes one writer finish
// before the next one starts, so their rows never interleave.
//
// Order (docs/architecture/data-platform.md, "Workspace lock protocol"): identity lock, then
// profile rows in ascending id order, then this lock, then the membership rows. Every taker of
// this lock holds no profile-row lock it still needs and takes no identity lock afterwards, so the
// orders cannot cross. A transaction that writes several segments takes their locks in ascending
// segment id order (`lockSegmentMemberships` sorts): the segment scheduler, the streaming update
// and the consent re-evaluation each touch more than one.

/** The advisory key of one segment's membership writers. */
export const segmentLockKey = (segmentId: string) => `segment:${segmentId}`;

/**
 * Takes the membership lock for each named segment for the rest of the transaction. Idempotent, and
 * always ascending by segment id, so a transaction that locks several segments cannot meet another
 * transaction taking the same two in the other order.
 */
export async function lockSegmentMemberships(tx: Tx, segmentIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(segmentIds)].sort();
  for (const id of ids) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${segmentLockKey(id)}, 0))`);
}
