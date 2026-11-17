import {
  claimErasureCleanupJobs,
  completeErasureCleanup,
  type Db,
  deferErasureCleanup,
  dropErasedProfileOutbox,
  ERASURE_CLEANUP_LEASE_MS,
  ERASURE_CLEANUP_MAX_ATTEMPTS,
  type ErasureCleanupClaim,
  type ErasureCleanupFailureCategory,
  erasureCleanupFailure,
  erasureOutboxOutstanding,
  failErasureCleanup,
  formatErasureCleanupFailure,
  markErasureCleanupCheckpoint,
  renewErasureCleanupLease,
  resetErasureCleanupCheckpoints,
} from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { type ErasureSelectors, openSelectors } from './erasure';

// The erasure cleanup worker (#978 part 2b). Claiming is one short statement; the ClickHouse and
// Valkey deletions run outside any transaction. A crashed worker's lease expires and another one
// claims the job, skipping a store whose checkpoint was already written. The deletions are
// idempotent, so a crash between the deletion and its checkpoint is harmless.

export interface ErasureCleanupDeps {
  db: Db;
  kp: KeyProvider;
  events: Pick<EventStore, 'deleteEventsOf'>;
  hot?: Pick<HotState, 'deleteSnapshot'>;
}

export interface ErasureCleanupOptions {
  batch?: number;
  leaseMs?: number;
  maxAttempts?: number;
  /** How long a job waits when undelivered outbox rows still name the person. */
  outboxWaitSeconds?: number;
}

export interface ErasureCleanupResult {
  claimed: number;
  completed: number;
  deferred: number;
  retried: number;
  failed: number;
}

/** How long a job waits while an outbox publisher is still in flight for the erased person. */
export const ERASURE_OUTBOX_WAIT_SECONDS = 5;

/**
 * The selectors a job needs. Normally they are sealed in the job with its own service key. A job
 * created by a restore replay can have none: the restored snapshot may still carry the person's
 * identifiers in `warehouse_erasure_keys`, captured when the replay deleted them. Profile ids alone
 * are still enough to delete the person's message and journey events.
 */
async function selectorsFor(deps: ErasureCleanupDeps, claim: ErasureCleanupClaim): Promise<ErasureSelectors> {
  if (claim.selectors && claim.selectorKey && claim.selectorKek) {
    const key = await deps.kp.unwrap(claim.selectorKey, claim.selectorKek);
    try {
      return openSelectors(key, claim.selectors);
    } finally {
      // The unwrapped service key has served its purpose; do not leave a copy in memory.
      key.fill(0);
    }
  }
  const { rows } = await deps.db.admin.query<{ type: string; value: string }>(
    `SELECT type, value FROM warehouse_erasure_keys
     WHERE workspace_id = $1 AND profile_id = ANY($2::text[]) AND type IN ('anonymous_id', 'user_id')`,
    [claim.workspaceId, claim.profileIds],
  );
  return {
    anonymousIds: rows.filter((r) => r.type === 'anonymous_id').map((r) => r.value),
    userIds: rows.filter((r) => r.type === 'user_id').map((r) => r.value),
  };
}

/**
 * One round: claim a small batch, run each cleanup outside any transaction, checkpoint each store,
 * and complete or back off. Returns counts so a test (and the loop's idle pause) needs no clock.
 */
export async function runErasureCleanupOnce(deps: ErasureCleanupDeps, opts: ErasureCleanupOptions = {}): Promise<ErasureCleanupResult> {
  const leaseMs = opts.leaseMs ?? ERASURE_CLEANUP_LEASE_MS;
  const claims = await claimErasureCleanupJobs(deps.db, {
    ...(opts.batch === undefined ? {} : { limit: opts.batch }),
    leaseMs,
  });
  const result: ErasureCleanupResult = { claimed: claims.length, completed: 0, deferred: 0, retried: 0, failed: 0 };
  for (const claim of claims) {
    // A batch is claimed at once, so renew just before handling each row: slow work on an early
    // job must not let a later one's lease expire under it. False means another worker owns it.
    if (!(await renewErasureCleanupLease(deps.db, claim, leaseMs))) {
      logger.debug({ erasureId: claim.erasureId }, 'erasure cleanup claim was taken over; skipping');
      continue;
    }
    let stage: ErasureCleanupFailureCategory = 'barrier_wait';
    try {
      // A publisher still holding an outbox row for this person could recreate data after the
      // sweep. Wait for it before deleting anything; the job keeps its checkpoints meanwhile.
      if ((await erasureOutboxOutstanding(deps.db, claim.workspaceId, claim.profileIds)) > 0) {
        await deferErasureCleanup(deps.db, claim, opts.outboxWaitSeconds ?? ERASURE_OUTBOX_WAIT_SECONDS);
        result.deferred++;
        continue;
      }
      stage = 'unknown';
      const selectors = await selectorsFor(deps, claim);
      if (!claim.clickhouseDone) {
        stage = 'clickhouse_error';
        await deps.events.deleteEventsOf(claim.workspaceId, {
          anonymousIds: selectors.anonymousIds,
          userIds: selectors.userIds,
          profileIds: claim.profileIds,
        });
        if (!(await markErasureCleanupCheckpoint(deps.db, claim, 'clickhouse'))) {
          logger.debug({ erasureId: claim.erasureId }, 'erasure ClickHouse checkpoint was stale');
          continue;
        }
      }
      if (!claim.hotstateDone) {
        stage = 'hot_state_error';
        if (deps.hot)
          await deps.hot.deleteSnapshot(claim.workspaceId, {
            anonymousIds: selectors.anonymousIds,
            userIds: selectors.userIds,
          });
        if (!(await markErasureCleanupCheckpoint(deps.db, claim, 'hotstate'))) {
          logger.debug({ erasureId: claim.erasureId }, 'erasure hot-state checkpoint was stale');
          continue;
        }
      }
      stage = 'barrier_wait';
      // A publisher that was still in flight when the sweep started could have added a row just
      // after the barrier check: sweep again before completing instead of leaving it behind.
      if ((await erasureOutboxOutstanding(deps.db, claim.workspaceId, claim.profileIds)) > 0) {
        await resetErasureCleanupCheckpoints(deps.db, claim);
        await deferErasureCleanup(deps.db, claim, opts.outboxWaitSeconds ?? ERASURE_OUTBOX_WAIT_SECONDS);
        result.deferred++;
        continue;
      }
      // Failed and delivered rows can still name the person (a DOI token, a click URL), and a
      // requeue could deliver one after this job completes.
      await dropErasedProfileOutbox(deps.db, claim.workspaceId, claim.profileIds);
      // A requeue could have turned a failed row into a pending one between the checks: sweep once
      // more rather than complete on a queue that is no longer empty.
      if ((await erasureOutboxOutstanding(deps.db, claim.workspaceId, claim.profileIds)) > 0) {
        await resetErasureCleanupCheckpoints(deps.db, claim);
        await deferErasureCleanup(deps.db, claim, opts.outboxWaitSeconds ?? ERASURE_OUTBOX_WAIT_SECONDS);
        result.deferred++;
        continue;
      }
      stage = 'unknown';
      if (await completeErasureCleanup(deps.db, claim)) result.completed++;
      else logger.debug({ erasureId: claim.erasureId }, 'erasure completion was stale; another claim owns the job');
    } catch (err) {
      const failure = erasureCleanupFailure(err, stage);
      const state = await failErasureCleanup(deps.db, claim, failure, {
        maxAttempts: opts.maxAttempts ?? ERASURE_CLEANUP_MAX_ATTEMPTS,
      });
      if (state === 'stale') {
        logger.debug({ erasureId: claim.erasureId }, 'erasure cleanup failure was stale; another claim owns the job');
        continue;
      }
      if (state === 'failed') result.failed++;
      else result.retried++;
      // Only the fixed category, class name and status are logged; a provider message can echo the
      // selectors, which name the erased person.
      logger.warn(
        { erasureId: claim.erasureId, attempts: claim.attempts, error: formatErasureCleanupFailure(failure) },
        'erasure cleanup failed',
      );
    }
  }
  return result;
}

/**
 * Runs cleanup rounds until `signal` aborts. Safe next to another replica: claims use
 * `FOR UPDATE SKIP LOCKED` and a lease, so two workers never own one job at once.
 */
export async function runErasureCleanup(
  deps: ErasureCleanupDeps,
  signal: AbortSignal,
  opts: ErasureCleanupOptions & { idleMs?: number } = {},
): Promise<void> {
  const idleMs = opts.idleMs ?? 1000;
  while (!signal.aborted) {
    let claimed = 0;
    try {
      claimed = (await runErasureCleanupOnce(deps, opts)).claimed;
    } catch (err) {
      logger.error({ err }, 'erasure cleanup round failed');
    }
    if (!claimed) await new Promise((r) => setTimeout(r, idleMs));
  }
}
