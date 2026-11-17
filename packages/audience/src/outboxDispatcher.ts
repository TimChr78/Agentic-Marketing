import {
  ackOutbox,
  claimOutboxBatch,
  type Db,
  failOutbox,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_DAYS,
  type OutboxClaim,
  pruneOutbox,
  renewOutboxLease,
  sanitiseOutboxError,
} from '@agentic-marketing/db';
import { type EmailRequest, requestEmail } from '@agentic-marketing/email';
import { type EventStore, messageEventPayloadSchema } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { z } from 'zod';

// The outbox dispatcher (#978 part 2). Claiming is one short transaction; the handler performs its
// I/O after it commits. A crashed dispatcher leaves a lease that expires, so the row is delivered
// again: at-least-once, with the payload's stable ids making the second delivery harmless.

export interface OutboxDispatcherDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
}

export interface OutboxDispatchOptions {
  batch?: number;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface OutboxDispatchResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/** A row this version can never deliver: failing it immediately beats eight identical attempts. */
class PermanentOutboxError extends Error {}

// The payload schema lives with the event shape (packages/events/src/pending.ts): the dispatcher
// and a reader that needs the queued events before publication parse the same batch.
const messageEventPayload = messageEventPayloadSchema;

/**
 * A confirmation send intent. `idempotencyKey` is required (and checked against the row's
 * operation key): a missing key must never fall back to a random one, or overlapping claims would
 * queue two confirmations.
 */
const doiPayload = z.object({
  profileId: z.string().min(1),
  templateId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

function parseOrPermanent<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .slice(0, 5)
      .join(', ');
    throw new PermanentOutboxError(`${label} payload is invalid: ${fields}`);
  }
  return parsed.data;
}

/** Runs one handler. Throws when the work has to be retried; the row then backs off. */
async function deliver(deps: OutboxDispatcherDeps, claim: OutboxClaim): Promise<void> {
  if (claim.kind === 'message_event') {
    const { events } = parseOrPermanent(messageEventPayload, claim.payload, 'message_event');
    if (events.some((event) => event.workspaceId !== claim.workspaceId))
      throw new PermanentOutboxError('message_event payload names another workspace');
    await deps.events.insertMessageEvents(events);
    return;
  }
  if (claim.kind === 'doi_send') {
    const req = parseOrPermanent(doiPayload, claim.payload, 'doi_send');
    if (req.idempotencyKey !== claim.operationKey)
      throw new PermanentOutboxError('doi_send idempotency key does not match its operation key');
    // requestEmail re-checks the recipient and keeps the `doi:<message>` key, so a redelivery
    // replays the message instead of sending a second confirmation.
    const decision = await deps.db.withWorkspace(claim.workspaceId, (tx) =>
      requestEmail(tx, claim.workspaceId, deps.kp, req as EmailRequest),
    );
    if (decision.status !== 'queued' && !decision.duplicate)
      logger.warn(
        { outboxId: claim.id, messageId: decision.messageId, status: decision.status, reason: decision.reason },
        'confirmation e-mail not queued',
      );
    return;
  }
  // A row this version cannot understand would otherwise be retried forever after a rollback to
  // an older release. It fails once, visibly, and stays for inspection.
  throw new PermanentOutboxError(`unknown outbox kind: ${claim.kind}`);
}

/**
 * One round: claim a small batch, run each handler outside any transaction, acknowledge successes
 * and back off failures. Returns counts so a test (and the loop's idle pause) needs no clock.
 */
export async function dispatchOutboxOnce(deps: OutboxDispatcherDeps, opts: OutboxDispatchOptions = {}): Promise<OutboxDispatchResult> {
  const leaseMs = opts.leaseMs ?? OUTBOX_LEASE_MS;
  const claims = await claimOutboxBatch(deps.db, {
    ...(opts.batch === undefined ? {} : { limit: opts.batch }),
    leaseMs,
  });
  const result: OutboxDispatchResult = { claimed: claims.length, delivered: 0, retried: 0, failed: 0 };
  for (const claim of claims) {
    // The whole batch was claimed at once, so a slow handler on an early row could let a later
    // row's lease expire. Renew immediately before handling it; a false answer means another
    // dispatcher took the row over, so this one must not run the handler.
    if (!(await renewOutboxLease(deps.db, claim, leaseMs))) {
      logger.debug({ outboxId: claim.id, kind: claim.kind }, 'outbox claim was taken over; skipping');
      continue;
    }
    try {
      await deliver(deps, claim);
      if (await ackOutbox(deps.db, claim)) result.delivered++;
      else logger.debug({ outboxId: claim.id, kind: claim.kind }, 'outbox ack was stale; another claim owns the row');
    } catch (err) {
      const permanent = err instanceof PermanentOutboxError;
      const state = await failOutbox(deps.db, claim, err, {
        permanent,
        ...(permanent ? {} : { maxAttempts: opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS }),
      });
      if (state === 'stale') {
        logger.debug({ outboxId: claim.id, kind: claim.kind }, 'outbox failure was stale; another claim owns the row');
        continue;
      }
      if (state === 'failed') result.failed++;
      else result.retried++;
      // The payload can hold personal data; only the row id, kind, attempt and a bounded error go
      // to the log.
      logger.warn(
        { outboxId: claim.id, kind: claim.kind, attempts: claim.attempts, error: sanitiseOutboxError(err) },
        'outbox delivery failed',
      );
    }
  }
  return result;
}

/** How often the loop prunes delivered rows, independent of whether it had work. */
const PRUNE_INTERVAL_MS = 10 * 60_000;

/**
 * Runs dispatcher rounds until `signal` aborts. Safe next to another replica: claims use
 * `FOR UPDATE SKIP LOCKED` and a lease, so two dispatchers never run the same row at once.
 */
export async function runOutboxDispatcher(
  deps: OutboxDispatcherDeps,
  signal: AbortSignal,
  opts: OutboxDispatchOptions & { idleMs?: number; retentionDays?: number; leaseMs?: number } = {},
) {
  const idleMs = opts.idleMs ?? 500;
  const retentionDays = opts.retentionDays ?? OUTBOX_RETENTION_DAYS;
  const leaseMs = opts.leaseMs ?? OUTBOX_LEASE_MS;
  let lastPrune = 0;
  while (!signal.aborted) {
    let claimed = 0;
    try {
      claimed = (await dispatchOutboxOnce(deps, { ...opts, leaseMs })).claimed;
    } catch (err) {
      logger.error({ err }, 'outbox dispatcher round failed');
    }
    if (Date.now() - lastPrune >= PRUNE_INTERVAL_MS) {
      lastPrune = Date.now();
      await pruneOutbox(deps.db, retentionDays).catch((err) => logger.warn({ err }, 'outbox prune failed'));
    }
    if (!claimed) await new Promise((r) => setTimeout(r, idleMs));
  }
}
