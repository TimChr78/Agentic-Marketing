import { runAudienceSyncs, runSpendImport } from '@agentic-marketing/ads';
import { runAiWorker, runExpiredHoldSweep } from '@agentic-marketing/ai';
import { runAlertEvaluator } from '@agentic-marketing/alerts';
import { runBroadcasts, runOutboxDispatcher, runRetention } from '@agentic-marketing/audience';
import { runContentFetches } from '@agentic-marketing/content';
import { type Db, runIdempotencyKeyCleanup, runSentAtBackfill } from '@agentic-marketing/db';
import { runDeliveryWorker } from '@agentic-marketing/email';
import { runDeliveries, runTokenRefresher } from '@agentic-marketing/integrations';
import { runEnrollmentJobs, runSweeper } from '@agentic-marketing/journeys';
import { runEdgeSync } from '@agentic-marketing/personalize';
import { runErasureCleanup } from '@agentic-marketing/profiles';
import { runSegmentScheduler } from '@agentic-marketing/segments';
import { runWarehouseExports } from '@agentic-marketing/warehouse';
import { describe, expect, it } from 'vitest';
import { runAgentEvents } from '../src/agents/events';
import { runGuardian } from '../src/agents/guardian';
import { runHolds } from '../src/agents/holds';
import { runHostedAgents } from '../src/agents/hosted';
import { runAgentNotifications } from '../src/agents/notifications';
import { runExperienceRollouts } from '../src/agents/rollouts';
import { runPasswordResetDeliveries } from '../src/passwordReset';
import { runOAuthSelectionCleanup } from '../src/workers';

// #1028: a scheduler that stops on SIGTERM must not hold the process open. Every loop used to await
// a plain `setTimeout` between rounds and register its abort listener afterwards, so a stop that
// landed while a round was running was never seen and the loop sat out a whole tick — an hour for
// retention, six for the spend import, thirty seconds for the segment scheduler. `runRetention`,
// `runTokenRefresher`, `runAudienceSyncs` and `runSpendImport` were the four the test-server close
// report named in CI.
//
// Each loop is driven with a dependency, not a service: a round that blocks until the signal aborts
// stands in for a slow pool or provider call, and an instant round leaves the loop asleep. The bound
// is a cancellation latency, generous on purpose: a loop that misses the signal waits hours, so any
// bound far below a tick detects it on a loaded runner.

const PROMPT_MS = 2_000;
/** Time for a round (or the first sleep) to be under way before the abort. */
const SETTLE_MS = 150;

/** An empty stand-in for a dependency the loop only passes on; the round fails fast and the loop sleeps. */
const anything = <T>(): T => ({}) as T;

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/**
 * A pool whose statements answer at once, or not until the abort: the second is the shape of a slow
 * query or provider call that only returns when shutdown reaches it. No row is returned, so a round
 * has nothing to iterate unless the loop is given one.
 */
function fakeDb(signal: AbortSignal, opts: { block?: boolean; rows?: unknown[]; rowCount?: number } = {}): Db {
  const query = async () => {
    if (opts.block) await untilAborted(signal);
    return { rows: opts.rows ?? [], rowCount: opts.rowCount ?? 0 };
  };
  const tx = { execute: query, select: () => ({ from: async () => [] }) };
  return {
    admin: { query, connect: async () => ({ query, release: () => undefined }) },
    withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    close: async () => undefined,
  } as unknown as Db;
}

/** One entry per loop the scheduler and worker roles start. */
const LOOPS: { name: string; start: (signal: AbortSignal, block: boolean) => Promise<unknown> }[] = [
  {
    name: 'retention',
    // A hot state that answers: the round then reaches its statements, which are the slow part.
    start: (signal, block) =>
      runRetention(
        {
          db: fakeDb(signal, { block }),
          events: anything(),
          hot: { cached: async () => null, cache: async () => undefined } as never,
        } as never,
        signal,
        3_600_000,
      ),
  },
  {
    name: 'token refresher',
    start: (signal, block) => runTokenRefresher({ db: fakeDb(signal, { block }), kp: anything(), egress: anything() }, signal, 3_600_000),
  },
  {
    name: 'audience syncs',
    start: (signal, block) => runAudienceSyncs({ db: fakeDb(signal, { block }), kp: anything(), egress: anything() }, signal, 3_600_000),
  },
  {
    name: 'spend import',
    start: (signal, block) =>
      runSpendImport({ db: fakeDb(signal, { block }), events: anything(), kp: anything(), egress: anything() }, signal, 3_600_000),
  },
  {
    name: 'broadcasts',
    start: (signal, block) => runBroadcasts({ db: fakeDb(signal, { block }), kp: anything(), events: anything() }, signal, 3_600_000),
  },
  {
    name: 'outbox dispatcher',
    start: (signal, block) =>
      runOutboxDispatcher({ db: fakeDb(signal, { block }), kp: anything(), events: anything() }, signal, { idleMs: 3_600_000 }),
  },
  {
    name: 'sent_at backfill',
    // A full batch per turn means `more`, so the loop reaches its pause instead of finishing.
    start: (signal, block) =>
      runSentAtBackfill({ db: { admin: fakeDb(signal, { block, rowCount: 1 }).admin } }, signal, { batchSize: 1, pauseMs: 3_600_000 }),
  },
  {
    name: 'idempotency key cleanup',
    start: (signal, block) => runIdempotencyKeyCleanup({ db: { admin: fakeDb(signal, { block }).admin } }, signal, { tickMs: 3_600_000 }),
  },
  {
    name: 'expired AI budget holds',
    start: (signal, block) => runExpiredHoldSweep({ db: { admin: fakeDb(signal, { block }).admin } }, signal, { tickMs: 3_600_000 }),
  },
  {
    name: 'segment scheduler',
    start: (signal, block) =>
      runSegmentScheduler({ db: fakeDb(signal, { block }), events: anything(), bus: anything(), tickMs: 3_600_000 }, signal),
  },
  {
    name: 'content sources',
    start: (signal, block) => runContentFetches({ db: fakeDb(signal, { block }), egress: anything() }, signal, { tickMs: 3_600_000 }),
  },
  {
    name: 'enrollment jobs',
    start: (signal, block) =>
      runEnrollmentJobs({ db: fakeDb(signal, { block }), kp: anything(), events: anything() }, signal, { tickMs: 3_600_000 }),
  },
  {
    name: 'journey sweeper',
    start: (signal, block) => runSweeper(fakeDb(signal, { block }), { kp: anything(), events: anything() }, signal),
  },
  {
    name: 'erasure cleanup',
    start: (signal, block) =>
      runErasureCleanup({ db: fakeDb(signal, { block }), kp: anything(), events: anything(), hot: anything() }, signal, {
        idleMs: 3_600_000,
      }),
  },
  {
    name: 'ai steps',
    start: (signal, block) => runAiWorker(fakeDb(signal, { block }), { kp: anything(), events: anything(), egress: anything() }, signal),
  },
  {
    name: 'email delivery',
    start: (signal, block) =>
      runDeliveryWorker(fakeDb(signal, { block }), { kp: anything(), events: anything(), email: anything() }, signal),
  },
  {
    name: 'webhook deliveries',
    start: (signal, block) => runDeliveries(fakeDb(signal, { block }), { kp: anything(), egress: anything(), hot: anything() }, signal),
  },
  {
    name: 'edge sync',
    start: (signal, block) =>
      runEdgeSync({ db: fakeDb(signal, { block }), hot: anything(), kp: anything(), egress: anything(), tickMs: 3_600_000 }, signal),
  },
  {
    name: 'warehouse exports',
    start: (signal, block) =>
      runWarehouseExports(
        { db: fakeDb(signal, { block }), events: anything(), kp: anything(), egress: anything(), tickMs: 3_600_000 },
        signal,
      ),
  },
  {
    name: 'alerts',
    start: (signal, block) =>
      runAlertEvaluator(
        {
          db: fakeDb(signal, { block }),
          events: anything(),
          kp: anything(),
          email: anything(),
          directory: anything(),
          publicUrl: 'http://localhost',
        },
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  { name: 'held changes', start: (signal, block) => runHolds({ db: fakeDb(signal, { block }), services: anything() }, signal, 3_600_000) },
  {
    name: 'guardian',
    start: (signal, block) =>
      runGuardian(
        {
          db: fakeDb(signal, { block }),
          services: anything(),
          kp: anything(),
          email: anything(),
          directory: anything(),
          publicUrl: 'http://localhost',
        },
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  {
    name: 'agent notifications',
    start: (signal, block) =>
      runAgentNotifications(
        { db: fakeDb(signal, { block }), kp: anything(), email: anything(), directory: anything(), publicUrl: 'http://localhost' },
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  { name: 'agent events', start: (signal, block) => runAgentEvents({ db: fakeDb(signal, { block }) }, signal, { tickMs: 3_600_000 }) },
  {
    name: 'experience rollouts',
    start: (signal, block) =>
      runExperienceRollouts(
        {
          db: fakeDb(signal, { block }),
          events: anything(),
          hot: anything(),
          kp: anything(),
          email: anything(),
          directory: anything(),
          publicUrl: 'http://localhost',
        },
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  {
    name: 'hosted agents',
    start: (signal, block) =>
      runHostedAgents(
        {
          db: fakeDb(signal, { block }),
          executor: anything(),
          kp: anything(),
          email: anything(),
          directory: anything(),
          publicUrl: 'http://localhost',
        },
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  {
    name: 'password reset delivery',
    start: (signal, block) =>
      runPasswordResetDeliveries(
        {
          db: fakeDb(signal, { block }),
          kp: anything(),
          email: anything(),
          directory: anything(),
          publicUrl: 'http://localhost',
          auth: anything(),
        } as never,
        signal,
        { tickMs: 3_600_000 },
      ),
  },
  // One pass at start and then on an interval rather than between rounds; it still owns a timer that
  // must not outlive the signal.
  {
    name: 'oauth selection cleanup',
    start: (signal, block) => runOAuthSelectionCleanup(fakeDb(signal, { block }), signal, { tickMs: 3_600_000 }),
  },
];

describe('a scheduler stops on shutdown (#1028)', () => {
  for (const loop of LOOPS) {
    it(`${loop.name} resolves promptly when the abort lands mid-round`, async () => {
      const stop = new AbortController();
      const running = loop.start(stop.signal, true);
      // The round is under way and blocked, exactly as a slow query or provider call leaves it.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      const aborted = Date.now();
      stop.abort();
      await expect(running).resolves.toBeUndefined();
      expect(Date.now() - aborted).toBeLessThan(PROMPT_MS);
    }, 20_000);

    it(`${loop.name} resolves promptly when the abort lands while it waits between rounds`, async () => {
      const stop = new AbortController();
      const running = loop.start(stop.signal, false);
      // The round is over; the loop is in its sleep, which is a whole tick long.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      const aborted = Date.now();
      stop.abort();
      await expect(running).resolves.toBeUndefined();
      expect(Date.now() - aborted).toBeLessThan(PROMPT_MS);
    }, 20_000);
  }
});
