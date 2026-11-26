import { sleep } from '@agentic-marketing/core';
import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import type { Db, Tx } from './pool';
import * as schema from './schema';

// Durable external cleanup for one erasure (#978 part 2b). The SQL stage writes a row in the same
// transaction as the deletion; the scheduler claims it with a lease, cleans ClickHouse and hot
// state outside any transaction, checkpoints each store and then completes. See
// packages/db/migrations/0108_erasure_cleanup_jobs.sql.

/**
 * The part of a pool these helpers use. A `Db`'s admin pool, a checked-out client inside a
 * workspace transaction, and a test double all satisfy it (#1194 review: the restore runs them in
 * the `app.workspace_id` transaction).
 */
export type Queryable = Pick<pg.Pool, 'query'>;

/** Attempts before a job stops retrying and stays `failed` for an operator. */
export const ERASURE_CLEANUP_MAX_ATTEMPTS = 36;
/** How long one worker may hold a claim before another may take it over. */
export const ERASURE_CLEANUP_LEASE_MS = 60_000;

export type ErasureCleanupCheckpoint = 'clickhouse' | 'hotstate';

/**
 * Why a pending or running erasure cleanup has not completed. Stored on the job so a status read
 * can explain a wait without re-deriving worker state, and never contains personal data.
 */
export type ErasureCompletionReason = 'publication' | 'outbox' | 'final_sweep' | 'subject_key_coverage';

/**
 * The only categories a cleanup failure may store. A provider error can echo the request (and the
 * erased person's identifiers), so the message is never stored or logged; a category, the error
 * class name and an HTTP status are enough for an operator.
 */
export type ErasureCleanupFailureCategory = 'clickhouse_error' | 'hot_state_error' | 'timeout' | 'barrier_wait' | 'unknown';

export interface ErasureCleanupFailure {
  category: ErasureCleanupFailureCategory;
  /** A code-level class name (`TypeError`, `ClickHouseError`), never a message. */
  errorClass?: string;
  /** An HTTP or client status code, when the error carries one. */
  statusCode?: number;
}

/** Error names an operator can act on; anything else is reported as `other`. */
const KNOWN_ERROR_CLASSES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
  'ClickHouseError',
  'ReplyError',
  'MaxRetriesPerRequestError',
]);

/** Classifies an error without looking at its message, which may contain personal data. */
export function erasureCleanupFailure(err: unknown, category: ErasureCleanupFailureCategory): ErasureCleanupFailure {
  const name = err instanceof Error ? err.name : '';
  // A name is caller/provider-controlled metadata, not a fixed code literal: map it against a
  // small allowlist so an error naming a person can never reach last_error, the log or the status.
  const errorClass = KNOWN_ERROR_CLASSES.has(name) ? name : 'other';
  const raw = (err as { status?: unknown; statusCode?: unknown }) ?? {};
  const status = typeof raw.statusCode === 'number' ? raw.statusCode : typeof raw.status === 'number' ? raw.status : undefined;
  const statusCode = status !== undefined && Number.isFinite(status) && status >= 0 ? Math.trunc(status) : undefined;
  const timeout = name === 'TimeoutError' || name === 'AbortError';
  return {
    category: timeout ? 'timeout' : category,
    errorClass,
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

/** The bounded operator-facing text stored in `last_error`, built only from allowlisted fields. */
export function formatErasureCleanupFailure(failure: ErasureCleanupFailure): string {
  const detail = [failure.errorClass, failure.statusCode === undefined ? '' : `status ${failure.statusCode}`].filter(Boolean).join(', ');
  return detail ? `${failure.category} (${detail})` : failure.category;
}

export interface ErasureCleanupEntry {
  erasureId: string;
  profileIds: string[];
  /** The anonymous and user ids sealed with the job's service key; null when a replay has none. */
  selectors?: Buffer | null;
  /** The service key, wrapped by the configured KEK. */
  selectorKey?: Buffer | null;
  selectorKek?: string | null;
}

export interface ErasureCleanupClaim {
  workspaceId: string;
  erasureId: string;
  profileIds: string[];
  /** Already incremented by the claim: this is the attempt being run. */
  attempts: number;
  /** Set from the first claim, which is necessarily after the erasure transaction committed. */
  finalSweepAt: Date;
  /** Set when the first ClickHouse delete succeeded; null until then. */
  firstSweepDoneAt: Date | null;
  /** Whether a distinct final pass is due: at least `finalSweepSeconds` after `firstSweepDoneAt`. */
  finalDue: boolean;
  /** Fences completion and checkpoints: only the claim holding this token may write them. */
  claimToken: string;
  clickhouseDone: boolean;
  hotstateDone: boolean;
  /** The generation published to ClickHouse's erased subjects; null until confirmed (#1037 part 2). */
  publishedGeneration: number | null;
  publishedAt: Date | null;
  /** When a FINAL coverage count reached zero; completion requires it (#1037 part 3). */
  coverageClearedAt: Date | null;
  /** Why this job is still waiting, when it is (#1037 part 3). */
  completionReason: ErasureCompletionReason | null;
  selectors: Buffer | null;
  selectorKey: Buffer | null;
  selectorKek: string | null;
}

/**
 * Bounded exponential backoff after attempt 1, 2, 3 …: 5 s, 10 s, 20 s … capped at one hour. No
 * jitter: the row's own `next_attempt_at` is the schedule, and a test can read it exactly.
 */
export function erasureCleanupRetrySeconds(attempts: number): number {
  return Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
}

/** Writes the job in the caller's transaction, as the erasure's SQL stage does. Idempotent. */
export async function enqueueErasureCleanupJob(tx: Tx, workspaceId: string, entry: ErasureCleanupEntry): Promise<void> {
  await tx
    .insert(schema.erasureCleanupJobs)
    .values({
      workspaceId,
      erasureId: entry.erasureId,
      profileIds: entry.profileIds,
      selectors: entry.selectors ?? null,
      selectorKey: entry.selectorKey ?? null,
      selectorKek: entry.selectorKek ?? null,
    })
    .onConflictDoNothing({ target: [schema.erasureCleanupJobs.workspaceId, schema.erasureCleanupJobs.erasureId] });
}

/**
 * Claims up to `limit` due jobs with `FOR UPDATE SKIP LOCKED` and a lease, in one short statement
 * that commits before any cleanup runs. A job whose lease expired (the worker died) is claimed
 * again. Every claim writes a fresh `claim_token`, so a completion or checkpoint from an expired
 * claim is a no-op rather than overwriting the new owner's result.
 */
export async function claimErasureCleanupJobs(
  db: Db,
  opts: { limit?: number; leaseMs?: number; finalSweepSeconds?: number } = {},
): Promise<ErasureCleanupClaim[]> {
  const limit = opts.limit ?? 10;
  const leaseMs = opts.leaseMs ?? ERASURE_CLEANUP_LEASE_MS;
  const finalSweepSeconds = opts.finalSweepSeconds ?? 35;
  const { rows } = await db.admin.query<{
    workspace_id: string;
    erasure_id: string;
    profile_ids: string[];
    attempts: number;
    final_sweep_at: Date;
    first_sweep_done_at: Date | null;
    final_due: boolean;
    claim_token: string;
    clickhouse_done: boolean;
    hotstate_done: boolean;
    published_generation: number | string | null;
    published_at: Date | null;
    coverage_cleared_at: Date | null;
    completion_reason: ErasureCompletionReason | null;
    selectors: Buffer | null;
    selector_key: Buffer | null;
    selector_kek: string | null;
  }>(
    `WITH ready AS (
       SELECT workspace_id, erasure_id FROM erasure_cleanup_jobs
       WHERE (state = 'pending_external' AND next_attempt_at <= now())
          OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= now())
       ORDER BY next_attempt_at, created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE erasure_cleanup_jobs j
     SET state = 'running',
         attempts = j.attempts + 1,
         final_sweep_at = COALESCE(j.final_sweep_at, now()),
         lease_until = now() + make_interval(secs => $2),
         claim_token = gen_random_uuid()::text,
         last_error = NULL,
         updated_at = now()
     FROM ready
     WHERE j.workspace_id = ready.workspace_id AND j.erasure_id = ready.erasure_id
     RETURNING j.workspace_id, j.erasure_id, j.profile_ids, j.attempts,
               COALESCE(j.final_sweep_at, now()) AS final_sweep_at,
               j.first_sweep_done_at,
               (j.first_sweep_done_at IS NOT NULL
                AND GREATEST(COALESCE(j.final_sweep_at, now()), j.first_sweep_done_at)
                    + make_interval(secs => $3::double precision) <= now()) AS final_due,
               j.claim_token, j.clickhouse_done, j.hotstate_done,
               j.published_generation, j.published_at, j.coverage_cleared_at, j.completion_reason,
               j.selectors, j.selector_key, j.selector_kek`,
    [limit, leaseMs / 1000, finalSweepSeconds],
  );
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    erasureId: r.erasure_id,
    profileIds: r.profile_ids,
    attempts: r.attempts,
    finalSweepAt: r.final_sweep_at,
    firstSweepDoneAt: r.first_sweep_done_at,
    finalDue: r.final_due,
    claimToken: r.claim_token,
    clickhouseDone: r.clickhouse_done,
    hotstateDone: r.hotstate_done,
    publishedGeneration: r.published_generation === null ? null : Number(r.published_generation),
    publishedAt: r.published_at,
    coverageClearedAt: r.coverage_cleared_at,
    completionReason: r.completion_reason,
    selectors: r.selectors,
    selectorKey: r.selector_key,
    selectorKek: r.selector_kek,
  }));
}

/** Extends a claim's lease. False when another worker took the job over. */
export async function renewErasureCleanupLease(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
  leaseMs = ERASURE_CLEANUP_LEASE_MS,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs SET lease_until = now() + make_interval(secs => $4), updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, leaseMs / 1000],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records that one external store is clean. A stale claim's checkpoint is refused: the reclaimer
 * will make the same deletion, which is idempotent, and owns the row's checkpoints. The ClickHouse
 * checkpoint also records when the first successful delete happened; the final pass is scheduled
 * from that timestamp, so a failed first delete cannot be completed by one later success (#1037).
 */
export async function markErasureCleanupCheckpoint(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
  store: ErasureCleanupCheckpoint,
): Promise<boolean> {
  // A fixed column name from the union, never caller text.
  const column = store === 'clickhouse' ? 'clickhouse_done' : 'hotstate_done';
  const firstSweep = store === 'clickhouse' ? ', first_sweep_done_at = COALESCE(first_sweep_done_at, now())' : '';
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs SET ${column} = true${firstSweep}, updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Clears both checkpoints so the next attempt sweeps both stores again. Used when an outbox
 * publisher was still in flight during the sweep and could have recreated an event afterwards.
 */
export async function resetErasureCleanupCheckpoints(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
     SET clickhouse_done = false, hotstate_done = false, updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Releases a job that cannot proceed yet (undelivered outbox rows still name the person) without
 * spending its attempt budget. A stale claim returns false and changes nothing.
 */
export async function deferErasureCleanup(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
  retrySeconds: number,
  reason: ErasureCompletionReason | null = null,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
     SET state = 'pending_external',
         attempts = GREATEST(attempts - 1, 0),
         next_attempt_at = now() + make_interval(secs => $4),
         lease_until = NULL,
         claim_token = NULL,
         completion_reason = $5,
         last_error = NULL,
         updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, retrySeconds, reason],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records that the workspace-wide subject-key coverage count reached zero while this claim held
 * the job (#1037 part 3). Completion requires this record, so a status cannot claim logical
 * completion while a stored row has no key that a protected read could check.
 */
export async function markErasureCoverageClear(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
        SET coverage_cleared_at = COALESCE(coverage_cleared_at, now()), updated_at = now()
      WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks the job complete and purges the sealed selectors and their service key: neither is needed
 * again, and both name the erased person. The completed row stays as the erasure's status record.
 *
 * Completion is gated in SQL as well as in the worker: a job that never published its exclusions,
 * or whose workspace still has rows a protected read cannot check, cannot be marked complete even
 * by a caller that skipped the worker's checks (#1037 part 3).
 */
export async function completeErasureCleanup(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
     SET state = 'complete',
         completed_at = now(),
         coverage_cleared_at = COALESCE(coverage_cleared_at, now()),
         completion_reason = NULL,
         selectors = NULL,
         selector_key = NULL,
         selector_kek = NULL,
         lease_until = NULL,
         claim_token = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'
       AND published_at IS NOT NULL AND coverage_cleared_at IS NOT NULL`,
    [claim.workspaceId, claim.erasureId, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records a failed attempt: back off with the bounded schedule, or stop after `maxAttempts` so a
 * permanent outage cannot retry forever. Checkpoints are kept; a rerun skips a store that already
 * succeeded. A stale claim returns `'stale'` and changes nothing.
 */
export async function failErasureCleanup(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'attempts' | 'claimToken'>,
  failure: ErasureCleanupFailure | unknown,
  opts: { maxAttempts?: number } = {},
): Promise<'pending' | 'failed' | 'stale'> {
  const maxAttempts = opts.maxAttempts ?? ERASURE_CLEANUP_MAX_ATTEMPTS;
  const retrySeconds = erasureCleanupRetrySeconds(claim.attempts);
  const record =
    typeof failure === 'object' && failure !== null && 'category' in failure
      ? (failure as ErasureCleanupFailure)
      : erasureCleanupFailure(failure, 'unknown');
  const { rows } = await db.admin.query<{ state: 'pending_external' | 'failed' }>(
    `UPDATE erasure_cleanup_jobs SET
       state = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending_external' END,
       next_attempt_at = CASE WHEN attempts >= $4 THEN next_attempt_at
                              ELSE now() + make_interval(secs => $5) END,
       lease_until = NULL,
       claim_token = NULL,
       last_error = $6,
       completion_reason = NULL,
       updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'
     RETURNING state`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, maxAttempts, retrySeconds, formatErasureCleanupFailure(record)],
  );
  return rows[0] ? (rows[0].state === 'failed' ? 'failed' : 'pending') : 'stale';
}

/**
 * The profile an outbox event is about. Message and DOI payloads carry `profileId`; a
 * `segment_change` batch puts it in `properties.profile_id` (#1136). A missing profile id is NULL:
 * callers treat that as "someone else", never as the erased person, so it can neither satisfy the
 * barrier nor cause a whole batch to be dropped.
 */
const OUTBOX_PROFILE = (value: string) => `coalesce(${value}->>'profileId', ${value}->'properties'->>'profile_id')`;

/** The SQL predicate that finds an outbox row naming one of the erased profiles. */
const NAMES_ERASED_PROFILE = `(
  ${OUTBOX_PROFILE('o.payload')} = ANY($2::text[])
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.payload->'events') = 'array' THEN o.payload->'events' ELSE '[]'::jsonb END
    ) AS e(event)
    WHERE ${OUTBOX_PROFILE('e.event')} = ANY($2::text[])
  )
)`;

/**
 * How many outbox rows for the erased profiles are still undelivered. The erasure's external
 * cleanup waits until this is zero: an in-flight publisher (a message event for ClickHouse) must
 * not recreate the erased person's data after the final sweep. Failed rows never publish, so they
 * do not block completion; `dropErasedProfileOutbox` removes them instead, so a later requeue
 * cannot resurrect the person.
 */
export async function erasureOutboxOutstanding(db: { admin: Queryable }, workspaceId: string, profileIds: string[]): Promise<number> {
  if (!profileIds.length) return 0;
  const { rows } = await db.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox o
     WHERE o.workspace_id = $1
       AND o.state IN ('pending', 'delivering')
       AND ${NAMES_ERASED_PROFILE}`,
    [workspaceId, profileIds],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Options for {@link dropErasedProfileOutbox}.
 */
export interface DropErasedProfileOutboxOptions {
  /**
   * Also remove `pending` and `delivering` rows. The cleanup worker never does this: an in-flight
   * dispatcher may be mid-delivery, so it waits for those rows to drain first. A restore holds the
   * exclusive restore lock, which proves no app, worker or scheduler is running, so a row cannot be
   * mid-delivery; it removes them rather than letting the started app publish data about someone
   * whose erasure is already complete (#1194 review).
   */
  includeUndelivered?: boolean;
}

/**
 * Removes outbox rows that still name the erased profiles after the barrier.
 *
 * A failed row can never deliver on its own, but `am outbox` could requeue it, so it goes. A
 * delivered row is kept no longer either: a DOI confirmation URL carries a token with the person's
 * anonymous id, and delivered message events keep identifying URLs. When a message-event batch
 * mixes the erased person with other people, only their entries are removed and the rest of the
 * batch stays; that also applies to a failed batch, whose unrelated events are still worth
 * requeueing.
 *
 * Both mutations are single SQL statements. A row that another process moves to `pending` or
 * `delivering` between sweeps is excluded by the state predicate at the moment of the mutation,
 * and the mixed batch is filtered from the payload the statement reads (under the row lock), so
 * two erasures cleaning the same batch cannot restore each other's entries. `includeUndelivered`
 * widens the state predicate for the restore, where the exclusive lock proves no dispatcher runs.
 */
export async function dropErasedProfileOutbox(
  db: { admin: Queryable },
  workspaceId: string,
  profileIds: string[],
  opts: DropErasedProfileOutboxOptions = {},
): Promise<number> {
  if (!profileIds.length) return 0;
  // `IN` over a fixed list, never caller text: the two states are literals of this module.
  const removable = opts.includeUndelivered ? `('pending', 'delivering', 'failed', 'delivered')` : `('failed', 'delivered')`;
  // A row wholly about the erased family: no event in its batch belongs to anyone else.
  const deleted = await db.admin.query(
    `DELETE FROM outbox o
     WHERE o.workspace_id = $1
       AND o.state IN ${removable}
       AND (
         (coalesce(jsonb_typeof(o.payload->'events'), 'none') <> 'array'
          AND ${OUTBOX_PROFILE('o.payload')} = ANY($2::text[]))
         OR (
           jsonb_typeof(o.payload->'events') = 'array'
           AND jsonb_array_length(o.payload->'events') > 0
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
             WHERE (${OUTBOX_PROFILE('e.event')} = ANY($2::text[])) IS DISTINCT FROM TRUE
           )
         )
       )`,
    [workspaceId, profileIds],
  );
  // A mixed batch keeps everyone else. The filter runs on the payload as it is when the row is
  // locked, not on a copy read earlier by another cleanup.
  await db.admin.query(
    `UPDATE outbox o
     SET payload = jsonb_set(o.payload, '{events}', (
           SELECT coalesce(jsonb_agg(e.event), '[]'::jsonb)
           FROM jsonb_array_elements(o.payload->'events') AS e(event)
           WHERE (${OUTBOX_PROFILE('e.event')} = ANY($2::text[])) IS DISTINCT FROM TRUE
         )),
         updated_at = now()
     WHERE o.workspace_id = $1
       AND o.state IN ${removable}
       AND jsonb_typeof(o.payload->'events') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
         WHERE ${OUTBOX_PROFILE('e.event')} = ANY($2::text[])
       )
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
         WHERE (${OUTBOX_PROFILE('e.event')} = ANY($2::text[])) IS DISTINCT FROM TRUE
       )`,
    [workspaceId, profileIds],
  );
  return deleted.rowCount ?? 0;
}

/** The erasure's job for a workspace read (under RLS), or null when the erasure predates jobs. */
export async function erasureCleanupJob(
  tx: Tx,
  workspaceId: string,
  erasureId: string,
): Promise<typeof schema.erasureCleanupJobs.$inferSelect | null> {
  const [job] = await tx
    .select()
    .from(schema.erasureCleanupJobs)
    .where(and(eq(schema.erasureCleanupJobs.workspaceId, workspaceId), eq(schema.erasureCleanupJobs.erasureId, erasureId)));
  return job ?? null;
}

/**
 * The workspace's confirmed-publication epoch (#1037 part 2). A query result cache keys on it: it
 * moves only after a publication's keys are visible in ClickHouse, so a query that ran *during*
 * publication can never leave a pre-exclusion answer under the current value. Keying on
 * `generation` instead would allow exactly that: the generation is allocated before the insert.
 */
export async function erasureVisibilityEpoch(tx: Tx, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ visible: schema.erasureGenerations.visiblePublications })
    .from(schema.erasureGenerations)
    .where(eq(schema.erasureGenerations.workspaceId, workspaceId));
  return Number(row?.visible ?? 0);
}

/** The number of workspaces a process remembers as having a durable erasure ledger. */
export const ERASURE_LEDGER_CACHE_MAX = 10_000;

export interface ErasureLedgerCheckerOptions {
  /** Called at most once per checker, when the ledger cannot be read. */
  onError?: (err: unknown) => void;
  /** How many positive workspaces to remember. Defaults to {@link ERASURE_LEDGER_CACHE_MAX}. */
  cacheMax?: number;
}

/**
 * A workspace's erasure check for the shared read layer (#1037 part 2). The signal is the **durable
 * ledger** — `erasure_keys`, written in the erasure's own SQL transaction — not a worker-allocated
 * generation: an erasure committed by an older release, or restored from a snapshot, has ledger rows
 * without ever having been published, and must still take the protected path.
 *
 * A positive is cached (nothing prunes `erasure_keys`, so it never becomes false) in a bounded LRU,
 * because a long-lived process must not grow a set per erased workspace. A negative is never
 * cached: the next erasure in that workspace has to take effect on the next read.
 *
 * A failure to read the ledger is fail-closed: every read stays on the protected path. It is
 * reported once per checker (not once per read) and rethrown with a fixed, explicit message, so an
 * operator sees a cause rather than a silent read-path outage.
 */
export function erasureLedgerChecker(
  db: Pick<Db, 'admin'>,
  opts: ErasureLedgerCheckerOptions = {},
): (workspaceId: string) => Promise<boolean> {
  const known = new Map<string, true>();
  const cacheMax = Math.max(1, opts.cacheMax ?? ERASURE_LEDGER_CACHE_MAX);
  let reported = false;
  return async (workspaceId: string) => {
    if (known.has(workspaceId)) {
      // Refresh the LRU position: the workspace is still being read.
      known.delete(workspaceId);
      known.set(workspaceId, true);
      return true;
    }
    try {
      const { rows } = await db.admin.query('SELECT 1 AS present FROM erasure_keys WHERE workspace_id = $1 LIMIT 1', [workspaceId]);
      if (!rows.length) return false;
      if (known.size >= cacheMax) known.delete(known.keys().next().value as string);
      known.set(workspaceId, true);
      return true;
    } catch (err) {
      if (!reported) {
        reported = true;
        opts.onError?.(err);
      }
      throw new Error(
        'the erasure ledger for this workspace could not be read, so person-linked reads fail closed; retry once the database is reachable',
        { cause: err },
      );
    }
  };
}

/**
 * Re-enqueues every erasure whose ledger has publishable rows but no recorded publication (#1037
 * part 2). Erasures whose cleanup completed before this release, or that predate durable jobs, have
 * committed `erasure_keys` (so reads already fail closed to the protected path) but no
 * `erased_subjects` rows. Idempotent: a job that already published is left alone, a job that is
 * still running keeps its claim token, lease and checkpoints, and a queued job stays queued. One
 * statement across tenants, like the claim itself.
 *
 * Only `full`-coverage rows are publishable, while the read-layer check protects on **any** ledger
 * row. A workspace whose only rows are `unavailable` therefore stays on the protected path with an
 * empty published set: fail closed, and nothing to publish. That asymmetry is deliberate.
 *
 * `reopenPublishedFailed` is the documented recovery for a job that failed **after** publishing:
 * `am doctor` and the operations guide tell an operator to fix Valkey or ClickHouse and restart the
 * scheduler role. The background pass runs it once at scheduler start, not on every tick, so a
 * permanent outage is retried with a fresh budget per start rather than forever (#1219).
 */
export async function enqueueUnpublishedErasures(db: Db, opts: { reopenPublishedFailed?: boolean } = {}): Promise<number> {
  const { rowCount } = await db.admin.query(
    `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids)
     SELECT e.workspace_id, e.id, e.profile_ids
       FROM erasures e
      WHERE EXISTS (
        SELECT 1 FROM erasure_keys k
         WHERE k.workspace_id = e.workspace_id AND k.erasure_id = e.id AND k.coverage = 'full'
      )
     ON CONFLICT (workspace_id, erasure_id) DO UPDATE
       SET state = 'pending_external',
           attempts = 0,
           next_attempt_at = now(),
           clickhouse_done = false,
           hotstate_done = false,
           published_generation = NULL,
           published_at = NULL,
           claim_token = NULL,
           lease_until = NULL,
           updated_at = now()
       -- Only a finished job may be re-opened. A running job has a live claim token and its
       -- checkpoints, and a scheduler start on another replica must not reset it underneath the
       -- worker; a pending_external job is already queued, so the pass leaves it alone (a
       -- repeated pass is a no-op). published_at stays the second condition: a job that already
       -- published must never publish again. A re-opened job gets a whole retry budget: keeping
       -- the burnt attempt count gave it one attempt before it landed in failed again.
       WHERE erasure_cleanup_jobs.published_at IS NULL
         AND erasure_cleanup_jobs.state IN ('complete', 'failed')`,
  );
  let reopened = rowCount ?? 0;
  if (opts.reopenPublishedFailed) {
    // A job that failed after its exclusion was published: reads already exclude the person, but
    // its ClickHouse purge and Valkey hot-state cleanup stopped, so a scheduler restart must queue
    // it again. Publication, checkpoints and the final-sweep clock are kept: the worker skips
    // publishing a job with `published_at` set and only redoes the stores that are not done.
    const { rowCount: published } = await db.admin.query(
      `UPDATE erasure_cleanup_jobs
          SET state = 'pending_external',
              attempts = 0,
              next_attempt_at = now(),
              lease_until = NULL,
              claim_token = NULL,
              updated_at = now()
        WHERE state = 'failed' AND published_at IS NOT NULL`,
    );
    reopened += published ?? 0;
  }
  return reopened;
}

/**
 * How often the scheduler re-opens erasures whose publication job failed or finished unpublished.
 * The pass is one indexed statement, so it is cheap enough to run while the cleanup queue drains.
 */
export const ERASURE_PUBLICATION_BACKLOG_INTERVAL_MS = 5 * 60 * 1000;

export interface ErasurePublicationBacklogOptions {
  tickMs?: number;
  log?: (message: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * The scheduler's periodic publication backlog pass (#1062). A cleanup job that burned its retry
 * budget lands `failed`, and the claim query only takes `pending_external`/`running`; without this
 * pass nothing re-opens it after the scheduler started. Re-enqueueing is idempotent, leaves a
 * running claim alone and never re-publishes a job that already published. The first pass after a
 * start also re-opens a job that failed after publishing, which is what the doctor hint and the
 * operations guide promise a scheduler restart does (#1219). The abortable sleep stops the loop on
 * shutdown instead of waiting out a whole tick.
 */
export async function runErasurePublicationBacklog(
  deps: { db: Db },
  signal: AbortSignal,
  opts: ErasurePublicationBacklogOptions = {},
): Promise<void> {
  const tickMs = opts.tickMs ?? ERASURE_PUBLICATION_BACKLOG_INTERVAL_MS;
  let first = true;
  while (!signal.aborted) {
    const reopenPublishedFailed = first;
    first = false;
    try {
      const count = await enqueueUnpublishedErasures(deps.db, { reopenPublishedFailed });
      if (count) opts.log?.(`re-enqueued ${count} erasure cleanup job(s)`);
    } catch (err) {
      opts.onError?.(err);
    }
    if (signal.aborted) return;
    await sleep(tickMs, signal);
  }
}

/**
 * Records that one publication is confirmed visible, moving the cache epoch. Called once per
 * successful publication, after the FINAL read, so concurrent publishers each move it exactly once
 * and a read can never observe a new epoch before the rows behind it are visible.
 */
export async function noteErasedSubjectsVisible(db: { admin: Queryable }, workspaceId: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO erasure_generations (workspace_id, visible_publications, visible_at) VALUES ($1, 1, now())
     ON CONFLICT (workspace_id) DO UPDATE
       SET visible_publications = erasure_generations.visible_publications + 1, visible_at = now(), updated_at = now()`,
    [workspaceId],
  );
}

/** One full-coverage ledger row the erasure stage committed for this erasure. */
export interface ErasureLedgerKey {
  kind: string;
  keyValue: string;
  keyVersion: string;
}

/**
 * The ledger rows one erasure published (#1037 part 2). Only `coverage = 'full'` rows are
 * publishable: an `unavailable` row keeps its matching-key value because the plaintext could not
 * be recovered, so it would never match a stored subject key and must not be published as if it
 * would. A read under the owner connection, scoped by the ledger's own key.
 */
export async function erasureLedgerKeys(db: Db, workspaceId: string, erasureId: string): Promise<ErasureLedgerKey[]> {
  const { rows } = await db.admin.query<ErasureLedgerKey>(
    `SELECT kind, key_value AS "keyValue", key_version AS "keyVersion"
       FROM erasure_keys
      WHERE workspace_id = $1 AND erasure_id = $2 AND coverage = 'full'
      ORDER BY kind, key_value, key_version`,
    [workspaceId, erasureId],
  );
  return rows;
}

/** The exclusion-coverage summary a status read reports (#1037 part 3). Counts only, never values. */
export interface ErasureLedgerCoverage {
  /** Ledger rows whose value is HMAC_exclusion and can be published. */
  full: number;
  /** Ledger rows whose plaintext could not be recovered; they cannot match a stored key. */
  unavailable: number;
  /** The distinct kinds of those unavailable rows, sorted. */
  unavailableKinds: string[];
}

/**
 * One erasure's ledger coverage, read under the caller's workspace transaction. The status API uses
 * it to say `partial` explicitly instead of implying that an unrecoverable e-mail or phone was
 * excluded. It reads at most the erasure's own ledger rows.
 */
export async function erasureLedgerCoverage(tx: Tx, workspaceId: string, erasureId: string): Promise<ErasureLedgerCoverage> {
  const rows = await tx
    .select({ kind: schema.erasureKeys.kind, coverage: schema.erasureKeys.coverage })
    .from(schema.erasureKeys)
    .where(and(eq(schema.erasureKeys.workspaceId, workspaceId), eq(schema.erasureKeys.erasureId, erasureId)));
  let full = 0;
  const unavailableKinds = new Set<string>();
  let unavailable = 0;
  for (const row of rows) {
    if (row.coverage === 'full') full++;
    else {
      unavailable++;
      unavailableKinds.add(row.kind);
    }
  }
  return { full, unavailable, unavailableKinds: [...unavailableKinds].sort() };
}

/** Every full-coverage exclusion key the workspace retains; the physical purge matches these. */
export async function erasureWorkspaceKeys(db: Db, workspaceId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ key_value: string }>(
    `SELECT DISTINCT key_value FROM erasure_keys WHERE workspace_id = $1 AND coverage = 'full' ORDER BY key_value`,
    [workspaceId],
  );
  return rows.map((row) => row.key_value);
}

/**
 * The next publication generation for a workspace (#1037 part 2). The upsert increments in one
 * statement, so two workers publishing for the same workspace can never take the same value and a
 * generation never moves backwards.
 */
export async function nextErasureGeneration(db: { admin: Queryable }, workspaceId: string): Promise<number> {
  const { rows } = await db.admin.query<{ generation: number | string }>(
    `INSERT INTO erasure_generations (workspace_id, generation) VALUES ($1, 1)
     ON CONFLICT (workspace_id) DO UPDATE
       SET generation = erasure_generations.generation + 1, updated_at = now()
     RETURNING generation`,
    [workspaceId],
  );
  return Number(rows[0]?.generation ?? 1);
}

/**
 * Records that a claim published its ledger and confirmed the result is visible. A stale claim
 * returns false and changes nothing: the new owner publishes the same keys, which is idempotent.
 */
export async function markErasureCleanupPublished(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
  generation: number,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
        SET published_generation = $4, published_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, generation],
  );
  return (rowCount ?? 0) > 0;
}

/** How often a workspace with retained exclusion keys is swept again, even after a completed pass. */
export const ERASURE_PURGE_INTERVAL_SECONDS = 5 * 60;
/** How long one worker may hold a workspace purge claim. */
export const ERASURE_PURGE_LEASE_MS = 60_000;

export interface ErasurePurgeClaim {
  workspaceId: string;
  /** The publication generation whose keys this sweep covers. */
  generation: number;
  purgedGeneration: number;
  claimToken: string;
}

export interface ErasurePurgeSweep {
  generation: number;
  deletedRows: number;
  /** True when the sweep reached the end of every table's matching rows. */
  complete: boolean;
}

/**
 * Claims due workspace purges. A workspace is due when its last completed sweep did not cover the
 * current publication generation, or when its last sweep is older than `intervalSeconds` — late
 * writes keep arriving after a completed erasure, so a purge is a recurring obligation, not a
 * one-off. `FOR UPDATE SKIP LOCKED` and a fencing token make several scheduler replicas safe.
 */
export async function claimErasurePurges(
  db: Db,
  opts: { limit?: number; leaseMs?: number; intervalSeconds?: number } = {},
): Promise<ErasurePurgeClaim[]> {
  const limit = opts.limit ?? 10;
  const leaseMs = opts.leaseMs ?? ERASURE_PURGE_LEASE_MS;
  const intervalSeconds = opts.intervalSeconds ?? ERASURE_PURGE_INTERVAL_SECONDS;
  const { rows } = await db.admin.query<{
    workspace_id: string;
    generation: number | string;
    purged_generation: number | string;
    purge_claim_token: string;
  }>(
    `WITH ready AS (
       SELECT workspace_id FROM erasure_generations
        WHERE (purge_lease_until IS NULL OR purge_lease_until <= now())
          AND (purged_generation < generation
               OR purge_last_sweep_at IS NULL
               OR purge_last_sweep_at <= now() - make_interval(secs => $3::double precision))
        ORDER BY COALESCE(purge_last_sweep_at, to_timestamp(0)), workspace_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE erasure_generations g
        SET purge_claim_token = gen_random_uuid()::text,
            purge_lease_until = now() + make_interval(secs => $2),
            updated_at = now()
       FROM ready
      WHERE g.workspace_id = ready.workspace_id
      RETURNING g.workspace_id, g.generation, g.purged_generation, g.purge_claim_token`,
    [limit, leaseMs / 1000, intervalSeconds],
  );
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    generation: Number(row.generation),
    purgedGeneration: Number(row.purged_generation),
    claimToken: row.purge_claim_token,
  }));
}

/** Extends a purge claim. False when another worker took it over. */
export async function renewErasurePurgeLease(
  db: Db,
  claim: Pick<ErasurePurgeClaim, 'workspaceId' | 'claimToken'>,
  leaseMs = ERASURE_PURGE_LEASE_MS,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_generations SET purge_lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE workspace_id = $1 AND purge_claim_token = $2`,
    [claim.workspaceId, claim.claimToken, leaseMs / 1000],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records one sweep. `complete` advances `purged_generation` to the generation the sweep covered;
 * an incomplete pass only records progress and time, so the next round continues from the same
 * obligation. A stale claim changes nothing.
 */
export async function recordErasurePurgeSweep(
  db: Db,
  claim: Pick<ErasurePurgeClaim, 'workspaceId' | 'claimToken'>,
  sweep: ErasurePurgeSweep,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_generations
        SET purged_generation = CASE WHEN $4 THEN GREATEST(purged_generation, $3) ELSE purged_generation END,
            purge_last_sweep_at = now(),
            purge_deleted_rows = purge_deleted_rows + $5,
            purge_claim_token = NULL,
            purge_lease_until = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND purge_claim_token = $2`,
    [claim.workspaceId, claim.claimToken, sweep.generation, sweep.complete, sweep.deletedRows],
  );
  return (rowCount ?? 0) > 0;
}

/** Releases a purge claim without recording a completed obligation (a failure or a stop). */
export async function releaseErasurePurge(db: Db, claim: Pick<ErasurePurgeClaim, 'workspaceId' | 'claimToken'>): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_generations SET purge_claim_token = NULL, purge_lease_until = NULL, updated_at = now()
      WHERE workspace_id = $1 AND purge_claim_token = $2`,
    [claim.workspaceId, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/** Physical-purge progress for a status read (#1037 part 3). Reads under the workspace transaction. */
export interface ErasurePurgeProgress {
  state: 'pending' | 'running' | 'done';
  lastSweepAt: Date | null;
  deletedRows: number;
}

export async function erasurePurgeProgress(tx: Tx, workspaceId: string, publishedGeneration: number | null): Promise<ErasurePurgeProgress> {
  const [row] = await tx
    .select({
      purgedGeneration: schema.erasureGenerations.purgedGeneration,
      lastSweepAt: schema.erasureGenerations.purgeLastSweepAt,
      deletedRows: schema.erasureGenerations.purgeDeletedRows,
      leaseUntil: schema.erasureGenerations.purgeLeaseUntil,
    })
    .from(schema.erasureGenerations)
    .where(eq(schema.erasureGenerations.workspaceId, workspaceId));
  if (!row) return { state: publishedGeneration === 0 ? 'done' : 'pending', lastSweepAt: null, deletedRows: 0 };
  // A null generation means publication has not been confirmed yet, so there is nothing honest to
  // call purged. Zero means the erasure had no publishable key: no physical obligation.
  const done = publishedGeneration === 0 || (publishedGeneration !== null && Number(row.purgedGeneration) >= publishedGeneration);
  const running = Boolean(row.leaseUntil && row.leaseUntil.getTime() > Date.now());
  return {
    state: done ? 'done' : running ? 'running' : 'pending',
    lastSweepAt: row.lastSweepAt ?? null,
    deletedRows: Number(row.deletedRows),
  };
}
