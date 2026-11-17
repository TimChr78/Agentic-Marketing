import { performance } from 'node:perf_hooks';
import type { Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { sql } from 'drizzle-orm';

/**
 * The identity lock: one transaction-scoped advisory lock per workspace, held by every write that
 * must not interleave with an identity merge.
 *
 * Granularity is the workspace, not the profile, because a merge is decided from the identifiers
 * that point at an arbitrary set of profiles; a per-profile key would have to be taken for both
 * sides of every pair and could not be ordered for a chain. Identity resolution takes it in
 * `applyEvents` before it touches an event (including the fast-path `touch`), and every consent
 * writer, merge and erasure takes it before its row writes and commits, so two writers cannot both
 * decide the canonical profile from a stale view.
 *
 * Order: this lock precedes the row writes of the transaction that takes it. Nothing that takes it
 * also takes a broadcast run row or a send key (`lockSendKey`), and no send takes it at all, so the
 * two orders cannot cross. No network I/O may run while it is held: callers prepare their keys
 * (`prepareKeys`) before the transaction and use the memory-only provider inside it.
 */

/** Latency buckets in seconds, shared by the wait and hold histograms. */
const BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const histogram = (): Histogram => ({ buckets: BUCKETS.map(() => 0), sum: 0, count: 0 });

const metrics = {
  acquisitions: 0,
  contended: 0,
  reentrant: 0,
  wait: histogram(),
  hold: histogram(),
};

function observe(target: Histogram, seconds: number): void {
  // Cumulative buckets, so rendering is a straight copy (the same shape as the server's HTTP
  // histogram). Labels carry no workspace id or person: the protocol is per-process.
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) target.buckets[i] += 1;
  target.sum += seconds;
  target.count += 1;
}

/** A read-only copy of the identity-lock timings, for `/metrics` and the protocol tests. */
export interface IdentityLockSnapshot {
  acquisitions: number;
  /** Acquisitions that had to wait at all, i.e. another transaction held the lock. */
  contended: number;
  /** Takes that found the lock already held by the same transaction. */
  reentrant: number;
  buckets: readonly number[];
  wait: { buckets: number[]; sum: number; count: number };
  hold: { buckets: number[]; sum: number; count: number };
}

export function identityLockSnapshot(): IdentityLockSnapshot {
  return {
    acquisitions: metrics.acquisitions,
    contended: metrics.contended,
    reentrant: metrics.reentrant,
    buckets: BUCKETS,
    wait: { buckets: [...metrics.wait.buckets], sum: metrics.wait.sum, count: metrics.wait.count },
    hold: { buckets: [...metrics.hold.buckets], sum: metrics.hold.sum, count: metrics.hold.count },
  };
}

/** Resets the counters. Tests only: a process never resets a production metric. */
export function resetIdentityLockMetrics(): void {
  metrics.acquisitions = 0;
  metrics.contended = 0;
  metrics.reentrant = 0;
  metrics.wait = histogram();
  metrics.hold = histogram();
}

/**
 * The transactions that hold the lock, by the transaction object they were given. A marker, not a
 * `pg_locks` query: the check must be cheap and must not itself touch the database on every consent
 * write. `lockIdentity` adds the transaction here when `pg_advisory_xact_lock` has returned.
 */
const holders = new WeakSet<object>();
const acquiredAt = new WeakMap<object, number>();

/** Whether this transaction already holds the workspace identity lock. */
export function identityLockHeld(tx: Tx): boolean {
  return holders.has(tx);
}

/**
 * Refuses a consent write whose transaction does not hold the identity lock. Every writer takes it
 * before it reads the canonical profile or writes evidence; the helpers assert instead of taking it
 * themselves, so a caller cannot accidentally invert the lock order (a row lock first).
 */
export function assertIdentityLock(tx: Tx, what: string): void {
  if (holders.has(tx)) return;
  throw new Error(`${what} requires the workspace identity lock; take it with withIdentityLock before writing consent.`);
}

async function acquire(tx: Tx, workspaceId: string): Promise<boolean> {
  if (holders.has(tx)) {
    metrics.reentrant++;
    return false;
  }
  const started = performance.now();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
  const waited = (performance.now() - started) / 1_000;
  metrics.acquisitions++;
  if (waited > 0.001) metrics.contended++;
  observe(metrics.wait, waited);
  holders.add(tx);
  acquiredAt.set(tx, performance.now());
  if (waited >= 0.05) logger.debug({ waitedMs: Math.round(waited * 1_000) }, 'waited for the workspace identity lock');
  return true;
}

/** Takes the workspace identity lock for the rest of this transaction. Idempotent. */
export async function lockIdentity(tx: Tx, workspaceId: string): Promise<void> {
  await acquire(tx, workspaceId);
}

function releaseMetrics(tx: Tx): void {
  const since = acquiredAt.get(tx);
  if (since === undefined) return;
  acquiredAt.delete(tx);
  observe(metrics.hold, (performance.now() - since) / 1_000);
}

/**
 * Runs `fn` under the workspace identity lock, recording how long the lock was waited for and how
 * long the protected block held it. `fn` must be the transaction's work after the lock: the server
 * releases the advisory lock when the transaction commits, so `fn` should end with that work.
 */
export async function withIdentityLock<T>(tx: Tx, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const acquired = await acquire(tx, workspaceId);
  try {
    return await fn();
  } finally {
    // A nested call shares the outer block's hold; only the acquirer records it.
    if (acquired) releaseMetrics(tx);
  }
}

/** Like `withIdentityLock`, for a batch that may name several workspaces. Locks are taken in
 * sorted order so two such batches can never deadlock. */
export async function withIdentityLocks<T>(tx: Tx, workspaceIds: Iterable<string>, fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(workspaceIds)].sort();
  if (!ids.length) return fn();
  let acquired = false;
  for (const id of ids) acquired = (await acquire(tx, id)) || acquired;
  try {
    return await fn();
  } finally {
    if (acquired) releaseMetrics(tx);
  }
}
