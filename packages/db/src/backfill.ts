import type pg from 'pg';

// The `messages.sent_at` backfill (#453, 0.10.1 review). The 0.10.1 migration only adds the
// column, which is metadata-only; rewriting every completed message inside that transaction would
// take an ACCESS EXCLUSIVE lock and hold up every send on a large install. This job fills the rows
// afterwards in short batches. It is resumable (each batch selects rows that are still NULL) and
// safe to run from more than one scheduler: the batch locks candidates with SKIP LOCKED.

/** Statuses whose `sent_at` is the send time; queued, sending, suppressed and failed stay NULL. */
const COMPLETED = "('sent','delivered','bounced','complained')";

export const SENT_AT_BACKFILL_BATCH = 10_000;

export interface SentAtBackfillOnceOptions {
  batchSize?: number;
  /** Stop after this many batches; the caller can breathe and continue. Defaults to no limit. */
  maxBatches?: number;
  log?: (msg: string) => void;
}

export interface SentAtBackfillResult {
  batches: number;
  updated: number;
  /** True when the last batch was full, so more rows may still be waiting. */
  more: boolean;
}

/**
 * Fill one batch. The subquery uses the partial `messages_sent_at_pending` index, so a large
 * install scans only rows that still need it instead of the whole message log per batch.
 */
export async function backfillSentAtBatch(admin: Pick<pg.Pool, 'query'>, batchSize = SENT_AT_BACKFILL_BATCH): Promise<number> {
  const { rowCount } = await admin.query(
    `UPDATE messages m
        SET sent_at = m.updated_at
      WHERE (m.workspace_id, m.id) IN (
              SELECT c.workspace_id, c.id
                FROM messages c
               WHERE c.sent_at IS NULL
                 AND c.status IN ${COMPLETED}
               ORDER BY c.workspace_id, c.id
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )`,
    [batchSize],
  );
  return rowCount ?? 0;
}

/** Run batches until no completed message is left without `sent_at`, or `maxBatches` is reached. */
export async function backfillSentAtOnce(
  admin: Pick<pg.Pool, 'query'>,
  opts: SentAtBackfillOnceOptions = {},
): Promise<SentAtBackfillResult> {
  const batchSize = opts.batchSize ?? SENT_AT_BACKFILL_BATCH;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  let batches = 0;
  let updated = 0;
  while (batches < maxBatches) {
    const count = await backfillSentAtBatch(admin, batchSize);
    if (!count) return { batches, updated, more: false };
    batches++;
    updated += count;
    opts.log?.(`sent_at backfill: ${updated} completed message(s) filled`);
    if (count < batchSize) return { batches, updated, more: false };
  }
  return { batches, updated, more: true };
}

export interface SentAtBackfillOptions {
  batchSize?: number;
  /** How many batches to run before yielding, so one huge install does not hold the event loop. */
  batchesPerTurn?: number;
  pauseMs?: number;
  log?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler job: drains the backfill after start, then returns. A new process (or a restart
 * after a failed batch) starts again from whatever rows are still NULL; a message completed by an
 * old instance during a rolling upgrade is picked up by the next start.
 */
export async function runSentAtBackfill(
  deps: { db: { admin: Pick<pg.Pool, 'query'> } },
  signal: AbortSignal,
  opts: SentAtBackfillOptions = {},
): Promise<void> {
  const batchesPerTurn = opts.batchesPerTurn ?? 10;
  const pauseMs = opts.pauseMs ?? 1_000;
  while (!signal.aborted) {
    let result: SentAtBackfillResult;
    try {
      result = await backfillSentAtOnce(deps.db.admin, {
        batchSize: opts.batchSize,
        maxBatches: batchesPerTurn,
        log: opts.log,
      });
    } catch (err) {
      // The column or table may not exist yet (SKIP_MIGRATIONS); the next start retries.
      opts.onError?.(err);
      return;
    }
    if (!result.more) {
      if (result.updated) opts.log?.(`sent_at backfill complete: ${result.updated} message(s)`);
      return;
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pauseMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
