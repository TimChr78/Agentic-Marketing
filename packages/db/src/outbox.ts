import { newId } from '@agentic-marketing/core';
import type { Db, Tx } from './pool';
import * as schema from './schema';

// The transactional outbox (#978 part 2). A tenant transaction that implies network work writes a
// row here (same transaction, no I/O), and a dispatcher claims it with a short lease, commits,
// performs the I/O and acknowledges. See packages/db/migrations/0106_transactional_outbox.sql.
//
// `operation_key` is the stable id of the action: enqueueing the same action twice (a redelivered
// ingest batch, a retried route) writes nothing. The payload carries the ids the consumer needs, so
// a redelivery after a crash is harmless for an idempotent consumer.

/** Attempts before a row stops being retried and stays `failed` for inspection. */
export const OUTBOX_MAX_ATTEMPTS = 8;
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
    })
    .onConflictDoNothing({ target: [schema.outbox.workspaceId, schema.outbox.operationKey] })
    .returning({ id: schema.outbox.id });
  return { id: inserted[0]?.id ?? id, enqueued: inserted.length > 0 };
}

/**
 * Claims up to `limit` due rows with `FOR UPDATE SKIP LOCKED` and a lease, in one short statement
 * that commits before any handler runs. A row whose lease expired (the dispatcher died) is claimed
 * again, which is what makes delivery at-least-once. `now` is PostgreSQL's clock.
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
         last_error = NULL,
         updated_at = now()
     FROM ready
     WHERE o.workspace_id = ready.workspace_id AND o.id = ready.id
     RETURNING o.workspace_id, o.id, o.kind, o.payload, o.operation_key, o.attempts`,
    [limit, leaseMs / 1000],
  );
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    operationKey: r.operation_key,
    attempts: r.attempts,
  }));
}

/** Marks a claimed row delivered. The operation key stays for dedupe until the row is pruned. */
export async function ackOutbox(db: Db, claim: Pick<OutboxClaim, 'workspaceId' | 'id'>): Promise<void> {
  await db.admin.query(
    `UPDATE outbox SET state = 'delivered', delivered_at = now(), lease_until = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [claim.workspaceId, claim.id],
  );
}

/**
 * Records a failed attempt: back off with the bounded schedule, or stop after `maxAttempts` so a
 * permanently broken payload cannot retry forever. The lease is released either way.
 */
export async function failOutbox(
  db: Db,
  claim: Pick<OutboxClaim, 'workspaceId' | 'id' | 'attempts'>,
  err: unknown,
  opts: { maxAttempts?: number } = {},
): Promise<'pending' | 'failed'> {
  const maxAttempts = opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const retrySeconds = outboxRetrySeconds(claim.attempts);
  const { rows } = await db.admin.query<{ state: 'pending' | 'failed' }>(
    `UPDATE outbox SET
       state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
       next_attempt_at = CASE WHEN attempts >= $3 THEN next_attempt_at ELSE now() + make_interval(secs => $4) END,
       lease_until = NULL,
       last_error = $5,
       updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING state`,
    [claim.workspaceId, claim.id, maxAttempts, retrySeconds, sanitiseOutboxError(err)],
  );
  return rows[0]?.state ?? 'pending';
}

/** Removes delivered rows older than the retention window. Failed rows stay for inspection. */
export async function pruneOutbox(db: Db, retentionDays = OUTBOX_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await db.admin.query(
    `DELETE FROM outbox WHERE state = 'delivered' AND delivered_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}
