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
  sanitiseOutboxError,
} from '@agentic-marketing/db';
import { type EmailRequest, requestEmail } from '@agentic-marketing/email';
import type { EventStore, MessageEvent } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';

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

/** Runs one handler. Throws when the work has to be retried; the row then backs off. */
async function deliver(deps: OutboxDispatcherDeps, claim: OutboxClaim): Promise<void> {
  if (claim.kind === 'message_event') {
    const events = claim.payload.events;
    if (!Array.isArray(events) || !events.length) throw new PermanentOutboxError('message_event payload has no events array');
    await deps.events.insertMessageEvents(events as MessageEvent[]);
    return;
  }
  if (claim.kind === 'doi_send') {
    const req = claim.payload as unknown as EmailRequest;
    if (typeof req.profileId !== 'string' || typeof req.templateId !== 'string' || typeof req.requestHash !== 'string')
      throw new PermanentOutboxError('doi_send payload is incomplete');
    // requestEmail re-checks the recipient and keeps the `doi:<message>` key, so a redelivery
    // replays the message instead of sending a second confirmation.
    const decision = await deps.db.withWorkspace(claim.workspaceId, (tx) => requestEmail(tx, claim.workspaceId, deps.kp, req));
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
  const claims = await claimOutboxBatch(deps.db, {
    ...(opts.batch === undefined ? {} : { limit: opts.batch }),
    ...(opts.leaseMs === undefined ? {} : { leaseMs: opts.leaseMs }),
  });
  const result: OutboxDispatchResult = { claimed: claims.length, delivered: 0, retried: 0, failed: 0 };
  for (const claim of claims) {
    try {
      await deliver(deps, claim);
      await ackOutbox(deps.db, claim);
      result.delivered++;
    } catch (err) {
      const state = await failOutbox(deps.db, claim, err, {
        maxAttempts: err instanceof PermanentOutboxError ? 0 : (opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS),
      });
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
