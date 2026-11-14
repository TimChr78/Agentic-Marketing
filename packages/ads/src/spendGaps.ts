import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { addIncomplete, completeInterval, type DateInterval, normalizeIntervals, type SpendGap, type SpendKey } from './spendState';

// Table access for spend import completeness (#917 review rounds 2-3). Gaps are keyed by the same
// identity an ad_spend row carries, so the warning follows the stored spend rather than a
// connection. Every read-modify-write of one key runs under a transaction-scoped advisory lock, so
// two concurrent imports for the same account serialise instead of overwriting each other.

/** Reads one account's stored gap ranges. */
export async function readSpendGaps(tx: Tx, workspaceId: string, key: SpendKey): Promise<DateInterval[]> {
  const rows = await tx
    .select({ fromDate: schema.adSpendGaps.fromDate, toDate: schema.adSpendGaps.toDate })
    .from(schema.adSpendGaps)
    .where(
      and(
        eq(schema.adSpendGaps.workspaceId, workspaceId),
        eq(schema.adSpendGaps.platform, key.platform),
        eq(schema.adSpendGaps.account, key.account),
      ),
    );
  return normalizeIntervals(rows.map((row) => ({ from: row.fromDate, to: row.toDate })));
}

/** Replaces one account's gap ranges with the normalised list. Callers hold the advisory lock. */
export async function writeSpendGaps(tx: Tx, workspaceId: string, key: SpendKey, intervals: readonly DateInterval[]): Promise<void> {
  const next = normalizeIntervals(intervals);
  await tx
    .delete(schema.adSpendGaps)
    .where(
      and(
        eq(schema.adSpendGaps.workspaceId, workspaceId),
        eq(schema.adSpendGaps.platform, key.platform),
        eq(schema.adSpendGaps.account, key.account),
      ),
    );
  if (!next.length) return;
  await tx.insert(schema.adSpendGaps).values(
    next.map((interval) => ({
      workspaceId,
      platform: key.platform,
      account: key.account,
      fromDate: interval.from,
      toDate: interval.to,
    })),
  );
}

/**
 * Records one import's result for one account: a truncated read adds its window, a complete read
 * removes exactly its window. Serialised per (workspace, platform, account) with an advisory lock so
 * two imports cannot read the same list and overwrite each other.
 */
export async function recordSpendGaps(
  db: Db,
  workspaceId: string,
  key: SpendKey,
  change: { incomplete?: DateInterval; complete?: DateInterval },
): Promise<void> {
  await db.withWorkspace(workspaceId, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ad-spend-gaps:${workspaceId}:${key.platform}:${key.account}`}, 0))`,
    );
    const current = await readSpendGaps(tx, workspaceId, key);
    const next = change.incomplete
      ? addIncomplete(current, change.incomplete)
      : change.complete
        ? completeInterval(current, change.complete)
        : current;
    await writeSpendGaps(tx, workspaceId, key, next);
  });
}

/**
 * The gaps of any account of a platform whose spend a report reads, for its window. The report does
 * not filter `ad_spend` by account, so every account's gap can leave its cost short; the rows come
 * through the workspace transaction, so row-level security keeps other tenants out.
 */
export async function readSpendGapsForReport(
  tx: Tx,
  window: { since: string; until: string; platform?: 'meta' | 'google' },
): Promise<SpendGap[]> {
  const rows = await tx
    .select({ platform: schema.adSpendGaps.platform, fromDate: schema.adSpendGaps.fromDate, toDate: schema.adSpendGaps.toDate })
    .from(schema.adSpendGaps)
    .where(and(gte(schema.adSpendGaps.toDate, window.since), lte(schema.adSpendGaps.fromDate, window.until)));
  return rows
    .filter((row) => !window.platform || row.platform === window.platform)
    .map((row) => ({ platform: row.platform, from: row.fromDate, to: row.toDate }));
}
