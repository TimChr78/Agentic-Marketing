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
 *
 * Below it, the row order is profile rows, then journey participant rows, and profile rows are taken
 * in ascending id order (`lockProfileRows`). Every path that writes both follows it: an SDK batch
 * locks the profile rows it merges (inside `merge`), and the journey sweep — the one writer that
 * cannot take the workspace identity lock, because its wait-until conditions may reach ClickHouse —
 * locks a participant's profile before it claims the participant row, with SKIP LOCKED so it never
 * waits on a row a batch holds. A transaction that waits for a participant row only after it holds
 * its profile rows cannot form the cycle in #1011 (batch: profile → participant; sweep: profile,
 * never waiting, → participant).
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
  /** Bounded acquisitions that hit their deadline and were refused (#1074). */
  timeouts: 0,
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
  /** Bounded acquisitions that gave up at their deadline; a public request answers 503 for these. */
  timeouts: number;
  buckets: readonly number[];
  wait: { buckets: number[]; sum: number; count: number };
  hold: { buckets: number[]; sum: number; count: number };
}

export function identityLockSnapshot(): IdentityLockSnapshot {
  return {
    acquisitions: metrics.acquisitions,
    contended: metrics.contended,
    reentrant: metrics.reentrant,
    timeouts: metrics.timeouts,
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
  metrics.timeouts = 0;
  metrics.wait = histogram();
  metrics.hold = histogram();
}

/**
 * The workspace ids each transaction holds, by the transaction object it was given. A marker, not a
 * `pg_locks` query: the check must be cheap and must not itself touch the database on every consent
 * write. `lockIdentity` adds the workspace when `pg_advisory_xact_lock` has returned.
 */
const holders = new WeakMap<object, Set<string>>();
const acquiredAt = new WeakMap<object, Map<string, number>>();

function heldBy(tx: Tx): Set<string> {
  let set = holders.get(tx);
  if (!set) {
    set = new Set();
    holders.set(tx, set);
  }
  return set;
}

/** Whether this transaction holds the identity lock for this exact workspace. */
export function identityLockHeld(tx: Tx, workspaceId: string): boolean {
  return holders.get(tx)?.has(workspaceId) ?? false;
}

/** The workspaces this transaction holds the identity lock for, as taken. */
export function identityLockWorkspaces(tx: Tx): string[] {
  return [...(holders.get(tx) ?? [])];
}

/**
 * Refuses a consent write whose transaction does not hold this workspace's identity lock. Every
 * writer takes it before it reads the canonical profile or writes evidence; the helpers assert
 * instead of taking it themselves, so a caller cannot accidentally invert the lock order (a row
 * lock first). The check is per workspace: a transaction that locked one workspace is not
 * considered safe for another.
 */
export function assertIdentityLock(tx: Tx, workspaceId: string, what: string): void {
  if (identityLockHeld(tx, workspaceId)) return;
  throw new Error(`${what} requires the identity lock for workspace ${workspaceId}; take it with withIdentityLock before writing consent.`);
}

/** How long a caller may wait for the identity lock. Omitted or zero waits without a bound. */
export interface IdentityLockOptions {
  waitMs?: number;
}

/**
 * A bounded acquisition gave up: another transaction held the workspace lock for longer than the
 * caller allowed (#1074). Public request paths translate this to `503` with a `Retry-After`, so the
 * provider retries instead of holding a pool connection behind a long import or merge.
 */
export class IdentityLockTimeoutError extends Error {
  readonly code = 'identity_lock_timeout';
  constructor(
    readonly workspaceId: string,
    readonly waitMs: number,
  ) {
    super(`the workspace identity lock was not acquired within ${waitMs} ms`);
    this.name = 'IdentityLockTimeoutError';
  }
}

/**
 * Takes the workspace lock, or gives up after `opts.waitMs`. The bounded path sets PostgreSQL's
 * `lock_timeout` for the one statement and restores the caller's value after a successful take. A
 * timeout cancels the statement and aborts the transaction; `withWorkspace` rolls it back, which is
 * what a public handler wants before it answers `503`.
 */
async function acquire(tx: Tx, workspaceId: string, opts: IdentityLockOptions = {}): Promise<boolean> {
  if (identityLockHeld(tx, workspaceId)) {
    metrics.reentrant++;
    return false;
  }
  const started = performance.now();
  const waitMs = opts.waitMs;
  if (waitMs !== undefined && waitMs > 0) {
    const original =
      (await tx.execute<{ lock_timeout: string }>(sql`SELECT current_setting('lock_timeout') AS lock_timeout`)).rows[0]?.lock_timeout ??
      '0';
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${Math.ceil(waitMs)}ms`}, true)`);
    try {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
    } catch (err) {
      // Only the expected lock timeout (55P03 lock_not_available) becomes a refusal; a cancellation
      // or a real query error must keep propagating.
      const e = err as { code?: string; cause?: { code?: string } };
      if ((e.code ?? e.cause?.code) !== '55P03') throw err;
      metrics.timeouts++;
      throw new IdentityLockTimeoutError(workspaceId, waitMs);
    }
    await tx.execute(sql`SELECT set_config('lock_timeout', ${original}, true)`);
  } else {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${workspaceId}`}, 0))`);
  }
  const waited = (performance.now() - started) / 1_000;
  metrics.acquisitions++;
  if (waited > 0.001) metrics.contended++;
  observe(metrics.wait, waited);
  heldBy(tx).add(workspaceId);
  let times = acquiredAt.get(tx);
  if (!times) {
    times = new Map();
    acquiredAt.set(tx, times);
  }
  times.set(workspaceId, performance.now());
  if (waited >= 0.05) logger.debug({ waitedMs: Math.round(waited * 1_000) }, 'waited for the workspace identity lock');
  return true;
}

/** Takes the identity lock for one workspace for the rest of this transaction. Idempotent. */
export async function lockIdentity(tx: Tx, workspaceId: string, opts: IdentityLockOptions = {}): Promise<void> {
  await acquire(tx, workspaceId, opts);
}

/** Records how long the given workspaces' locks were held by this protected block. */
function releaseMetrics(tx: Tx, workspaceIds: readonly string[]): void {
  const times = acquiredAt.get(tx);
  if (!times) return;
  for (const id of workspaceIds) {
    const since = times.get(id);
    if (since === undefined) continue;
    times.delete(id);
    observe(metrics.hold, (performance.now() - since) / 1_000);
  }
  if (!times.size) acquiredAt.delete(tx);
}

/**
 * Runs `fn` under the workspace identity lock, recording how long the lock was waited for and how
 * long the protected block held it. `fn` must be the transaction's work after the lock: the server
 * releases the advisory lock when the transaction commits, so `fn` should end with that work.
 */
export async function withIdentityLock<T>(tx: Tx, workspaceId: string, fn: () => Promise<T>, opts: IdentityLockOptions = {}): Promise<T> {
  const acquired = await acquire(tx, workspaceId, opts);
  try {
    return await fn();
  } finally {
    // A nested call shares the outer block's hold; only the acquirer records it.
    if (acquired) releaseMetrics(tx, [workspaceId]);
  }
}

/** Like `withIdentityLock`, for a batch that may name several workspaces. Every missing workspace
 * is locked in sorted order, so two such batches can never deadlock. */
export async function withIdentityLocks<T>(
  tx: Tx,
  workspaceIds: Iterable<string>,
  fn: () => Promise<T>,
  opts: IdentityLockOptions = {},
): Promise<T> {
  const ids = [...new Set(workspaceIds)].sort();
  if (!ids.length) return fn();
  const acquired: string[] = [];
  try {
    for (const id of ids) if (await acquire(tx, id, opts)) acquired.push(id);
    return await fn();
  } finally {
    if (acquired.length) releaseMetrics(tx, acquired);
  }
}

/**
 * Locks the person's profile rows for the rest of the transaction, in ascending id order, and returns
 * the ids that were locked. This is the row half of the order documented above: profile rows
 * (ascending) before participant rows. A caller that must not wait for anyone — the journey sweep,
 * which holds claimed participant rows — passes `skipLocked` and treats a missing id as "someone else
 * is writing this person right now, try again next sweep".
 *
 * Only rows that are the person *today* are locked (`merged_into IS NULL`): a caller working from a
 * lookup that a merge has since overtaken would otherwise hold a folded-away row while writing the
 * survivor it did not lock (#1011 review). The condition is part of the locking statement, so
 * PostgreSQL rechecks it on the locked row version and a merge that commits between the caller's
 * lookup and this call leaves nothing to lock.
 *
 * `includeMerged` locks the given rows whether or not they are still the person today. An erasure
 * needs every family row (it deletes them) and a score finalisation keeps its call's exact profile id;
 * both must take every row they may later write before they touch a participant row.
 */
export async function lockProfileRows(
  tx: Tx,
  workspaceId: string,
  profileIds: Iterable<string>,
  opts: { skipLocked?: boolean; includeMerged?: boolean } = {},
): Promise<string[]> {
  const ids = [...new Set(profileIds)].sort();
  if (!ids.length) return [];
  const res = await tx.execute<{ id: string }>(sql`
    SELECT id FROM profiles
    WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(ids)}::text[])
      ${opts.includeMerged ? sql`` : sql`AND merged_into IS NULL`}
    ORDER BY id
    ${opts.skipLocked ? sql.raw('FOR NO KEY UPDATE SKIP LOCKED') : sql.raw('FOR NO KEY UPDATE')}`);
  return res.rows.map((r) => r.id);
}
