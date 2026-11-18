import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from './pool';
import * as schema from './schema';

// Durable external cleanup for one erasure (#978 part 2b). The SQL stage writes a row in the same
// transaction as the deletion; the scheduler claims it with a lease, cleans ClickHouse and hot
// state outside any transaction, checkpoints each store and then completes. See
// packages/db/migrations/0108_erasure_cleanup_jobs.sql.

/** Attempts before a job stops retrying and stays `failed` for an operator. */
export const ERASURE_CLEANUP_MAX_ATTEMPTS = 36;
/** How long one worker may hold a claim before another may take it over. */
export const ERASURE_CLEANUP_LEASE_MS = 60_000;

export type ErasureCleanupCheckpoint = 'clickhouse' | 'hotstate';

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
               j.published_generation, j.published_at, j.selectors, j.selector_key, j.selector_kek`,
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
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
     SET state = 'pending_external',
         attempts = GREATEST(attempts - 1, 0),
         next_attempt_at = now() + make_interval(secs => $4),
         lease_until = NULL,
         claim_token = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, retrySeconds],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks the job complete and purges the sealed selectors and their service key: neither is needed
 * again, and both name the erased person. The completed row stays as the erasure's status record.
 */
export async function completeErasureCleanup(
  db: Db,
  claim: Pick<ErasureCleanupClaim, 'workspaceId' | 'erasureId' | 'claimToken'>,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE erasure_cleanup_jobs
     SET state = 'complete',
         completed_at = now(),
         selectors = NULL,
         selector_key = NULL,
         selector_kek = NULL,
         lease_until = NULL,
         claim_token = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'`,
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
       updated_at = now()
     WHERE workspace_id = $1 AND erasure_id = $2 AND claim_token = $3 AND state = 'running'
     RETURNING state`,
    [claim.workspaceId, claim.erasureId, claim.claimToken, maxAttempts, retrySeconds, formatErasureCleanupFailure(record)],
  );
  return rows[0] ? (rows[0].state === 'failed' ? 'failed' : 'pending') : 'stale';
}

/** The SQL predicate that finds an outbox row naming one of the erased profiles. */
const NAMES_ERASED_PROFILE = `(
  o.payload->>'profileId' = ANY($2::text[])
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.payload->'events') = 'array' THEN o.payload->'events' ELSE '[]'::jsonb END
    ) AS e(event)
    WHERE event->>'profileId' = ANY($2::text[])
  )
)`;

/**
 * How many outbox rows for the erased profiles are still undelivered. The erasure's external
 * cleanup waits until this is zero: an in-flight publisher (a message event for ClickHouse) must
 * not recreate the erased person's data after the final sweep. Failed rows never publish, so they
 * do not block completion; `dropErasedProfileOutbox` removes them instead, so a later requeue
 * cannot resurrect the person.
 */
export async function erasureOutboxOutstanding(db: Db, workspaceId: string, profileIds: string[]): Promise<number> {
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
 * two erasures cleaning the same batch cannot restore each other's entries.
 */
export async function dropErasedProfileOutbox(db: Db, workspaceId: string, profileIds: string[]): Promise<number> {
  if (!profileIds.length) return 0;
  // A row wholly about the erased family: no event in its batch belongs to anyone else.
  const deleted = await db.admin.query(
    `DELETE FROM outbox o
     WHERE o.workspace_id = $1
       AND o.state IN ('failed', 'delivered')
       AND (
         (coalesce(jsonb_typeof(o.payload->'events'), 'none') <> 'array' AND o.payload->>'profileId' = ANY($2::text[]))
         OR (
           jsonb_typeof(o.payload->'events') = 'array'
           AND jsonb_array_length(o.payload->'events') > 0
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
             WHERE NOT (e.event->>'profileId' = ANY($2::text[]))
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
           WHERE NOT (e.event->>'profileId' = ANY($2::text[]))
         )),
         updated_at = now()
     WHERE o.workspace_id = $1
       AND o.state IN ('failed', 'delivered')
       AND jsonb_typeof(o.payload->'events') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
         WHERE e.event->>'profileId' = ANY($2::text[])
       )
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.payload->'events') AS e(event)
         WHERE NOT (e.event->>'profileId' = ANY($2::text[]))
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
 * The workspace's current exclusion publication generation (#1037 part 2). A query result computed
 * under an older generation may describe rows a later publication excluded, so a cache key includes
 * it; a publication therefore never has to invalidate a cache explicitly.
 */
export async function erasureGeneration(tx: Tx, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ generation: schema.erasureGenerations.generation })
    .from(schema.erasureGenerations)
    .where(eq(schema.erasureGenerations.workspaceId, workspaceId));
  return Number(row?.generation ?? 0);
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

/**
 * The next publication generation for a workspace (#1037 part 2). The upsert increments in one
 * statement, so two workers publishing for the same workspace can never take the same value and a
 * generation never moves backwards.
 */
export async function nextErasureGeneration(db: Db, workspaceId: string): Promise<number> {
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
