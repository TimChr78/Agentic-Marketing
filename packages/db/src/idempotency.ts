import type pg from 'pg';

// Idempotency-key retention (#976). A key stays replayable for 30 days; after that the request
// runs as a new one and stores a fresh row. The command layer ignores older rows in its replay
// lookup, so the behaviour is exact even before the scheduler's cleanup reaches them, and this
// job then removes them so `idempotency_keys` does not grow without limit.
//
// Every cutoff is computed by PostgreSQL (`now() - make_interval(days => …)`), the same clock that
// wrote `created_at`; the application's clock never takes part, so a skewed process cannot move the
// retention edge.
//
// Rows are written when a request commits, so a request still in progress has no newly committed
// result to delete. An expired key can keep its previous row visible until its reuse replaces it.
// The batch takes its candidate rows with `FOR UPDATE SKIP LOCKED`, like the sent_at backfill:
// several replicas can run the cleanup at once without waiting on each other, and a row a live
// transaction is touching is left for a later pass rather than blocked on or removed underneath it.
// Each batch is its own statement, so no long lock is held.
//
// Nothing else requires an expired row to stay. `idempotency_key_actions` (#975) links agent
// ledger rows to a stored response with ON DELETE CASCADE, so this plain DELETE removes the links
// with their key; a future child table without a cascade must be deleted first.

/** How long a key replays. The command layer and the cleanup read the same default. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/**
 * How long the journey hook keeps its per-event markers (#1011): only while the event stream can
 * still deliver the event again. JetStream keeps an event for at most 30 days (`NATS_RETENTION_HOURS`
 * caps at 24 * 30), so an older marker suppresses nothing, and the retention round prunes it.
 */
export const JOURNEY_EVENT_RETENTION_DAYS = 30;
/** Rows deleted per statement: bounded locks on a table every keyed write touches. */
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 5_000;
/** The most batches one scheduler tick runs, so a large backlog never monopolises a tick. */
export const IDEMPOTENCY_CLEANUP_MAX_BATCHES = 20;
/** The most time one scheduler tick spends deleting; the next tick continues the backlog. */
export const IDEMPOTENCY_CLEANUP_TIME_BUDGET_MS = 30_000;
/** The cleanup runs on the scheduler role; hourly keeps a busy table close to the retention edge. */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface IdempotencyCleanupOptions {
  retentionDays?: number;
  batchSize?: number;
  /** Batches per sweep; defaults to IDEMPOTENCY_CLEANUP_MAX_BATCHES; the next tick continues. */
  maxBatches?: number;
  /** Wall-clock budget per sweep; defaults to IDEMPOTENCY_CLEANUP_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface IdempotencyCleanupResult {
  batches: number;
  deleted: number;
  /** True when the sweep stopped before draining every expired row; the next tick continues. */
  more: boolean;
}

/**
 * Delete one batch of expired rows. The candidates are locked and ordered through the
 * `idempotency_keys_created_at` index, and the DELETE joins them by `ctid`, so it touches only the
 * batch instead of building a hash semi-join over the whole table.
 */
export async function deleteExpiredIdempotencyKeyBatch(
  admin: Pick<pg.Pool, 'query'>,
  opts: Pick<IdempotencyCleanupOptions, 'retentionDays' | 'batchSize'> = {},
): Promise<number> {
  const { rowCount } = await admin.query(
    `DELETE FROM idempotency_keys
      WHERE ctid = ANY (ARRAY(
              SELECT ctid
                FROM idempotency_keys
               WHERE created_at < now() - make_interval(days => $1)
               ORDER BY created_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            ))`,
    [opts.retentionDays ?? IDEMPOTENCY_RETENTION_DAYS, opts.batchSize ?? IDEMPOTENCY_CLEANUP_BATCH_SIZE],
  );
  return rowCount ?? 0;
}

/**
 * Run batches until no expired row is left, the batch or time budget is spent, or the signal
 * aborts. A budget stop reports `more: true`, so the runner continues on its next tick.
 */
export async function deleteExpiredIdempotencyKeys(
  admin: Pick<pg.Pool, 'query'>,
  opts: IdempotencyCleanupOptions = {},
): Promise<IdempotencyCleanupResult> {
  const batchSize = opts.batchSize ?? IDEMPOTENCY_CLEANUP_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? IDEMPOTENCY_CLEANUP_MAX_BATCHES;
  const deadline = Date.now() + (opts.timeBudgetMs ?? IDEMPOTENCY_CLEANUP_TIME_BUDGET_MS);
  let batches = 0;
  let deleted = 0;
  while (batches < maxBatches && !opts.signal?.aborted) {
    const count = await deleteExpiredIdempotencyKeyBatch(admin, { retentionDays: opts.retentionDays, batchSize });
    if (!count) return { batches, deleted, more: false };
    batches++;
    deleted += count;
    opts.log?.(`idempotency key cleanup: ${deleted} expired key(s) removed`);
    if (count < batchSize) return { batches, deleted, more: false };
    if (Date.now() >= deadline) return { batches, deleted, more: true };
  }
  return { batches, deleted, more: true };
}

export interface IdempotencyCleanupRunnerOptions extends IdempotencyCleanupOptions {
  tickMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler job: a pass at start, then one every `tickMs`. Each tick has a finite batch and
 * time budget; when it stops early, the next tick continues. A failed pass is reported and the
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
