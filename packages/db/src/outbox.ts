import { newId } from '@agentic-marketing/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from './pool';
import * as schema from './schema';

// The transactional outbox (#978 part 2). A tenant transaction that implies network work writes a
// row here (same transaction, no I/O), and a dispatcher claims it with a short lease, commits,
// performs the I/O and acknowledges. See packages/db/migrations/0106_transactional_outbox.sql.
//
// `operation_key` is the stable id of the action: enqueueing the same action twice (a redelivered
// ingest batch, a retried route) writes nothing. The payload carries the ids the consumer needs, so
// a redelivery after a crash is harmless for an idempotent consumer.

/**
 * Attempts before a row stops being retried and stays `failed` for inspection. With the capped
 * backoff below, a transient outage is retried for about 27 hours before the row is dead-lettered;
 * malformed payloads are failed on their first attempt by the dispatcher instead.
 */
export const OUTBOX_MAX_ATTEMPTS = 36;
/** Delivered rows are kept this long before pruning: long enough to inspect a settled batch. */
export const OUTBOX_RETENTION_DAYS = 7;
/** How long one delivery may hold a claim before another dispatcher may take it over. */
export const OUTBOX_LEASE_MS = 60_000;

export interface OutboxEntry {
  kind: string;
  /** Everything the handler needs; never logged by the dispatcher (it can hold personal data). */
  payload: Record<string, unknown>;
  /** Stable id of the action, unique per workspace (a redelivery must not enqueue a second row). */
  operationKey: string;
  /** Broadcast or journey the events belong to, for a publication barrier. */
  subjectRef?: string;
  /** Overrides the generated row id (tests and imports that already have one). */
  id?: string;
}

export interface OutboxClaim {
  workspaceId: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  operationKey: string;
  /** Already incremented by the claim: this is the attempt being run. */
  attempts: number;
  /** Fences completion: only the claim holding the row's current token may ack or fail it. */
  claimToken: string;
}

/**
 * Bounded exponential backoff after attempt 1, 2, 3 …: 5 s, 10 s, 20 s … capped at one hour. No
 * jitter: the row's own `next_attempt_at` is the schedule, and a test can read it exactly.
 */
export function outboxRetrySeconds(attempts: number): number {
  return Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
}

/**
 * The error text stored on the row. It is for operators, not a log line: the first 500 characters
 * of the message, with control characters flattened and runs of whitespace collapsed.
 */
export function sanitiseOutboxError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  const flattened = [...raw]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  const clean = flattened.replace(/\s+/g, ' ').trim().slice(0, 500);
  return clean || 'unknown error';
}

/**
 * Enqueues one action in the caller's transaction. The unique (workspace, operation_key) makes a
 * repeat a no-op, so a redelivered event adds no second row.
 */
export async function enqueueOutbox(tx: Tx, workspaceId: string, entry: OutboxEntry): Promise<{ id: string; enqueued: boolean }> {
  const id = entry.id ?? newId('obx');
  const inserted = await tx
    .insert(schema.outbox)
    .values({
      workspaceId,
      id,
      kind: entry.kind,
      payload: entry.payload,
      operationKey: entry.operationKey,
      subjectRef: entry.subjectRef ?? null,
    })
    .onConflictDoNothing({ target: [schema.outbox.workspaceId, schema.outbox.operationKey] })
    .returning({ id: schema.outbox.id });
  return { id: inserted[0]?.id ?? id, enqueued: inserted.length > 0 };
}

/**
 * Claims up to `limit` due rows with `FOR UPDATE SKIP LOCKED` and a lease, in one short statement
 * that commits before any handler runs. A row whose lease expired (the dispatcher died) is claimed
 * again, which is what makes delivery at-least-once. `now` is PostgreSQL's clock.
 *
 * Every claim gets a fresh `claim_token`; ack, fail and renewal only apply while the row still
 * carries it. Because a whole batch is claimed before the first handler runs, the dispatcher
 * renews a row's lease immediately before handling it (see `renewOutboxLease`), so slow work on an
 * early row cannot let a later row's lease expire under it.
 */
export async function claimOutboxBatch(db: Db, opts: { limit?: number; leaseMs?: number } = {}): Promise<OutboxClaim[]> {
  const limit = opts.limit ?? 25;
  const leaseMs = opts.leaseMs ?? OUTBOX_LEASE_MS;
  const { rows } = await db.admin.query<{
    workspace_id: string;
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    operation_key: string;
    attempts: number;
    claim_token: string;
  }>(
    `WITH ready AS (
       SELECT workspace_id, id FROM outbox
       WHERE (state = 'pending' AND next_attempt_at <= now())
          OR (state = 'delivering' AND lease_until IS NOT NULL AND lease_until <= now())
       ORDER BY next_attempt_at, created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox o
     SET state = 'delivering',
         attempts = o.attempts + 1,
         lease_until = now() + make_interval(secs => $2),
         claim_token = gen_random_uuid()::text,
         last_error = NULL,
         failure_kind = NULL,
         updated_at = now()
     FROM ready
     WHERE o.workspace_id = ready.workspace_id AND o.id = ready.id
     RETURNING o.workspace_id, o.id, o.kind, o.payload, o.operation_key, o.attempts, o.claim_token`,
    [limit, leaseMs / 1000],
  );
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    operationKey: r.operation_key,
    attempts: r.attempts,
    claimToken: r.claim_token,
  }));
}

/**
 * Extends the lease of a claim that is about to be handled. False when the row was reclaimed by
 * another dispatcher (or settled), in which case this claim must do nothing.
 */
export async function renewOutboxLease(
  db: Db,
  claim: Pick<OutboxClaim, 'workspaceId' | 'id' | 'claimToken'>,
  leaseMs = OUTBOX_LEASE_MS,
): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE outbox SET lease_until = now() + make_interval(secs => $4), updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND claim_token = $3 AND state = 'delivering'`,
    [claim.workspaceId, claim.id, claim.claimToken, leaseMs / 1000],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks a claimed row delivered. The token fences it: false means the claim expired and another
 * dispatcher owns the row now, so this completion is a no-op. The operation key stays for dedupe
 * until the row is pruned.
 */
export async function ackOutbox(db: Db, claim: Pick<OutboxClaim, 'workspaceId' | 'id' | 'claimToken'>): Promise<boolean> {
  const { rowCount } = await db.admin.query(
    `UPDATE outbox SET state = 'delivered', delivered_at = now(), lease_until = NULL, claim_token = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND claim_token = $3 AND state = 'delivering'`,
    [claim.workspaceId, claim.id, claim.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Records a failed attempt: back off with the bounded schedule, or stop after `maxAttempts` so a
 * transient failure cannot retry forever. `permanent` stops at once (an undeliverable payload) and
 * persists that distinction so a requeue does not loop it. The lease is released either way. A
 * stale claim returns `'stale'` and changes nothing; the current owner settles the row.
 */
export async function failOutbox(
  db: Db,
  claim: Pick<OutboxClaim, 'workspaceId' | 'id' | 'attempts' | 'claimToken'>,
  err: unknown,
  opts: { maxAttempts?: number; permanent?: boolean } = {},
): Promise<'pending' | 'failed' | 'stale'> {
  const maxAttempts = opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const permanent = opts.permanent ?? false;
  const retrySeconds = outboxRetrySeconds(claim.attempts);
  const { rows } = await db.admin.query<{ state: 'pending' | 'failed' }>(
    `UPDATE outbox SET
       state = CASE WHEN $7::boolean OR attempts >= $4 THEN 'failed' ELSE 'pending' END,
       next_attempt_at = CASE WHEN $7::boolean OR attempts >= $4 THEN next_attempt_at
                              ELSE now() + make_interval(secs => $5) END,
       failure_kind = CASE WHEN $7::boolean THEN 'permanent'
                           WHEN attempts >= $4 THEN 'exhausted' ELSE NULL END,
       lease_until = NULL,
       claim_token = NULL,
       last_error = $6,
       updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND claim_token = $3 AND state = 'delivering'
     RETURNING state`,
    [claim.workspaceId, claim.id, claim.claimToken, maxAttempts, retrySeconds, sanitiseOutboxError(err), permanent],
  );
  return rows[0]?.state ?? 'stale';
}

/**
 * Whether publication for one broadcast or journey is complete. A decision that depends on
 * ClickHouse events (the canary check, the subject-test winner) must wait while a row is pending or
 * being delivered; a failed row must not block it forever, so the caller proceeds but can warn.
 */
export async function outboxPublicationBarrier(
  tx: Tx,
  workspaceId: string,
  subjectRef: string,
): Promise<{ outstanding: number; failed: number }> {
  // Two separately indexed queries: each predicate is in WHERE, so the partial indexes
  // outbox_undelivered_subject and outbox_failed_subject are usable. An aggregate with FILTER
  // cannot use them and would scan every delivered row of the workspace on each retry.
  const outstanding = await tx
    .select({ one: sql<number>`1` })
    .from(schema.outbox)
    .where(
      and(
        eq(schema.outbox.workspaceId, workspaceId),
        eq(schema.outbox.subjectRef, subjectRef),
        inArray(schema.outbox.state, ['pending', 'delivering']),
      ),
    )
    .limit(1);
  const failed = await tx
    .select({ one: sql<number>`1` })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.workspaceId, workspaceId), eq(schema.outbox.subjectRef, subjectRef), eq(schema.outbox.state, 'failed')))
    .limit(1);
  return { outstanding: outstanding.length, failed: failed.length };
}

/** Removes delivered rows older than the retention window. Failed rows stay for inspection. */
export async function pruneOutbox(db: Db, retentionDays = OUTBOX_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await db.admin.query(
    `DELETE FROM outbox WHERE state = 'delivered' AND delivered_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

/**
 * Puts dead-lettered rows back in the queue, resetting their attempt budget. Operators run this
 * after an outage (`am outbox [--kind KIND]`); without it a long ClickHouse outage would leave
 * valid events `failed` forever. A permanent failure (an undeliverable payload) is skipped unless
 * `includePermanent` is set: requeueing it would only fail it again. Returns what was requeued and
 * how many permanent failures were left alone.
 */
export async function requeueFailedOutbox(
  db: Db,
  opts: { kind?: string; includePermanent?: boolean } = {},
): Promise<{ requeued: number; skippedPermanent: number }> {
  const includePermanent = opts.includePermanent ?? false;
  const { rows } = await db.admin.query<{ requeued: number; permanent: number }>(
    `WITH candidates AS (
       SELECT workspace_id, id, failure_kind = 'permanent' AS is_permanent
       FROM outbox
       WHERE state = 'failed' AND ($1::text IS NULL OR kind = $1)
     ), requeued AS (
       UPDATE outbox o
       SET state = 'pending', attempts = 0, next_attempt_at = now(), lease_until = NULL,
           claim_token = NULL, failure_kind = NULL, last_error = NULL, updated_at = now()
       FROM candidates c
       WHERE o.workspace_id = c.workspace_id AND o.id = c.id
         AND ($2::boolean OR NOT c.is_permanent)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM requeued)::int AS requeued,
            (SELECT count(*) FROM candidates WHERE is_permanent)::int AS permanent`,
    [opts.kind ?? null, includePermanent],
  );
  const requeued = rows[0]?.requeued ?? 0;
  const permanent = rows[0]?.permanent ?? 0;
  return { requeued, skippedPermanent: includePermanent ? 0 : permanent };
}
