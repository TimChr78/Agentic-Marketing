import { sleep } from '@agentic-marketing/core';
import {
  claimErasurePurges,
  type Db,
  ERASURE_PURGE_LEASE_MS,
  erasureWorkspaceKeys,
  recordErasurePurgeSweep,
  renewErasurePurgeLease,
} from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';

// The recurring physical purge (#1037 part 3). Read-time exclusion is the correctness boundary;
// this job only reduces what is retained. It sweeps the person-linked ClickHouse tables for rows
// whose effective subject keys match any full-coverage key the workspace still keeps, in bounded
// batches, and records how far it got. It never deletes the ledger, the selectors or the published
// exclusions it needs to keep matching, and it deliberately keeps running after an erasure
// completes because late writes can still arrive.

export interface ErasurePurgeDeps {
  db: Db;
  events: Pick<EventStore, 'purgeErasedSubjects'>;
}

export interface ErasurePurgeOptions {
  batch?: number;
  leaseMs?: number;
  /** Rows deleted per table per batch. */
  batchSize?: number;
  /** Batches per table in one round; the remainder is a later round. */
  maxBatches?: number;
  /** How often a workspace with retained keys is swept again after a completed pass. */
  intervalSeconds?: number;
}

export interface ErasurePurgeResult {
  claimed: number;
  completed: number;
  progressed: number;
  deleted: number;
  failed: number;
}

/**
 * One round: claim a small set of due workspaces, read their retained full-coverage keys, purge
 * each table in bounded batches and record the result. A stale claim changes nothing.
 */
export async function runErasurePurgeOnce(deps: ErasurePurgeDeps, opts: ErasurePurgeOptions = {}): Promise<ErasurePurgeResult> {
  const leaseMs = opts.leaseMs ?? ERASURE_PURGE_LEASE_MS;
  const claims = await claimErasurePurges(deps.db, {
    ...(opts.batch === undefined ? {} : { limit: opts.batch }),
    leaseMs,
    ...(opts.intervalSeconds === undefined ? {} : { intervalSeconds: opts.intervalSeconds }),
  });
  const result: ErasurePurgeResult = { claimed: claims.length, completed: 0, progressed: 0, deleted: 0, failed: 0 };
  for (const claim of claims) {
    if (!(await renewErasurePurgeLease(deps.db, claim, leaseMs))) continue;
    try {
      const keys = await erasureWorkspaceKeys(deps.db, claim.workspaceId);
      // The sweep can outlast one 60 s lease: 4 batches over 3 tables with synchronous mutations
      // can run longer. Renew and check before every batch; a false result means another replica
      // took the claim, so stop without another delete instead of overlapping its mutations.
      let leaseLost = false;
      const checkpoint = async () => {
        if (leaseLost) return false;
        const held = await renewErasurePurgeLease(deps.db, claim, leaseMs);
        if (!held) leaseLost = true;
        return held;
      };
      const sweep = keys.length
        ? await deps.events.purgeErasedSubjects(claim.workspaceId, keys, {
            ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
            ...(opts.maxBatches === undefined ? {} : { maxBatches: opts.maxBatches }),
            checkpoint,
          })
        : { deleted: 0, complete: true, tables: [] };
      const recorded = await recordErasurePurgeSweep(deps.db, claim, {
        generation: claim.generation,
        deletedRows: sweep.deleted,
        complete: sweep.complete,
      });
      if (!recorded) {
        logger.debug({ workspaceId: claim.workspaceId }, 'erasure purge claim was taken over; result ignored');
        continue;
      }
      result.deleted += sweep.deleted;
      if (sweep.complete) result.completed++;
      else result.progressed++;
    } catch (err) {
      // Keep the claim: a mutation already submitted to ClickHouse can outlive the lease, and
      // releasing the claim would let another replica start a second one immediately. Letting the
      // lease expire delays a retry by at most its length while the in-flight work finishes. The
      // claim token still fences a worker that lost the lease: its next checkpoint fails.
      //
      // A provider message can echo a key; only the class name and a fixed message are logged.
      result.failed++;
      logger.warn(
        { workspaceId: claim.workspaceId, errorClass: err instanceof Error ? err.name : 'other' },
        'erasure physical purge failed; reads remain protected',
      );
    }
  }
  return result;
}

/** Runs purge rounds until `signal` aborts. Safe next to another scheduler replica. */
export async function runErasurePurge(
  deps: ErasurePurgeDeps,
  signal: AbortSignal,
  opts: ErasurePurgeOptions & { idleMs?: number } = {},
): Promise<void> {
  const idleMs = opts.idleMs ?? 60_000;
  while (!signal.aborted) {
    let claimed = 0;
    try {
      claimed = (await runErasurePurgeOnce(deps, opts)).claimed;
    } catch (err) {
      logger.error({ err }, 'erasure physical purge round failed');
    }
    if (!claimed) await sleep(idleMs, signal);
  }
}
