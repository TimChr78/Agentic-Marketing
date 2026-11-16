import type pg from 'pg';

// Idempotency-key retention (#976). A key stays replayable for 30 days; after that the request
// runs as a new one and stores a fresh row. The command layer ignores older rows in its replay
// lookup, so the behaviour is exact even before the scheduler's cleanup reaches them, and this
// job then removes them so `idempotency_keys` does not grow without limit.
//
// Rows are written when a request commits, so a request still in progress has no row to delete.
// The batch also takes its candidate rows with `FOR UPDATE SKIP LOCKED`, like the sent_at
// backfill: several replicas can run the cleanup at once without waiting on each other, and a row
// a live transaction is touching is left for a later pass rather than blocked on or removed
// underneath it. Each batch is its own statement, so no long lock is held.
//
// Nothing references an idempotency row (no foreign key on main points at the table), so a plain
// DELETE is enough; a future child table should gain ON DELETE CASCADE or be deleted first.

/** How long a key replays. The command layer and the cleanup read the same default. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;
/** Rows deleted per statement: bounded locks on a table every keyed write touches. */
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 5_000;
/** The cleanup runs on the scheduler role; hourly keeps a busy table close to the retention edge. */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which a row no longer replays; the lookup and the cleanup share it. */
export function idempotencyCutoff(retentionDays = IDEMPOTENCY_RETENTION_DAYS, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export interface IdempotencyCleanupOptions {
  retentionDays?: number;
  batchSize?: number;
  /** The clock a batch is measured against; tests pin it. */
  now?: Date;
  /** Stop after this many batches; defaults to draining everything expired. */
  maxBatches?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface IdempotencyCleanupResult {
  batches: number;
  deleted: number;
  /** True when the last batch was full, so more expired rows may still be waiting. */
  more: boolean;
}

/** Delete one batch of expired rows, using the `idempotency_keys_created_at` index. */
export async function deleteExpiredIdempotencyKeyBatch(
  admin: Pick<pg.Pool, 'query'>,
  opts: Pick<IdempotencyCleanupOptions, 'retentionDays' | 'batchSize' | 'now'> = {},
): Promise<number> {
  const cutoff = idempotencyCutoff(opts.retentionDays, opts.now);
  const { rowCount } = await admin.query(
    `DELETE FROM idempotency_keys
      WHERE (workspace_id, key) IN (
              SELECT workspace_id, key
                FROM idempotency_keys
               WHERE created_at < $1
               ORDER BY created_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )`,
    [cutoff, opts.batchSize ?? IDEMPOTENCY_CLEANUP_BATCH_SIZE],
  );
  return rowCount ?? 0;
}

/** Run batches until no expired row is left, `maxBatches` is reached or the signal aborts. */
export async function deleteExpiredIdempotencyKeys(
  admin: Pick<pg.Pool, 'query'>,
  opts: IdempotencyCleanupOptions = {},
): Promise<IdempotencyCleanupResult> {
  const batchSize = opts.batchSize ?? IDEMPOTENCY_CLEANUP_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  let batches = 0;
  let deleted = 0;
  while (batches < maxBatches && !opts.signal?.aborted) {
    const count = await deleteExpiredIdempotencyKeyBatch(admin, { retentionDays: opts.retentionDays, batchSize, now: opts.now });
    if (!count) return { batches, deleted, more: false };
    batches++;
    deleted += count;
    opts.log?.(`idempotency key cleanup: ${deleted} expired key(s) removed`);
    if (count < batchSize) return { batches, deleted, more: false };
  }
  return { batches, deleted, more: true };
}

export interface IdempotencyCleanupRunnerOptions extends IdempotencyCleanupOptions {
  tickMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler job: a pass at start, then one every `tickMs`. A failed pass is reported and the
 * next tick retries; the rows are still ignored by the replay lookup in the meantime.
 */
export async function runIdempotencyKeyCleanup(
  deps: { db: { admin: Pick<pg.Pool, 'query'> } },
  signal: AbortSignal,
  opts: IdempotencyCleanupRunnerOptions = {},
): Promise<void> {
  const tickMs = opts.tickMs ?? IDEMPOTENCY_CLEANUP_INTERVAL_MS;
  while (!signal.aborted) {
    try {
      const result = await deleteExpiredIdempotencyKeys(deps.db.admin, { ...opts, signal });
      if (result.deleted) opts.log?.(`idempotency key cleanup: ${result.deleted} expired key(s) removed in ${result.batches} batch(es)`);
    } catch (err) {
      opts.onError?.(err);
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
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
