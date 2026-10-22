import { runDeliveryWorker } from '@agentic-marketing/email';
import { runSink } from '@agentic-marketing/events';
import { journeyHook, runSweeper } from '@agentic-marketing/journeys';
import { snapshotHook } from '@agentic-marketing/personalize';
import { runProfileWorkers } from '@agentic-marketing/profiles';
import { runSegmentScheduler, segmentHook } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import type { createServer } from './app';

/** Periodic jobs of the scheduler role. */
export function startScheduler(
  srv: ReturnType<typeof createServer>,
  signal: AbortSignal,
  opts: { segmentTickMs?: number } = {},
): Promise<void>[] {
  logger.info('scheduler role: segment recomputation');
  return [runSegmentScheduler({ db: srv.db, events: srv.events, bus: srv.bus, tickMs: opts.segmentTickMs }, signal)];
}

/** Event consumers of the worker role. Each runs until `signal` aborts. */
export function startWorkers(srv: ReturnType<typeof createServer>, signal: AbortSignal): Promise<void>[] {
  const run = (name: string, p: Promise<void>) =>
    p.catch((err) => {
      logger.error({ err, worker: name }, 'worker stopped');
      throw err;
    });
  logger.info('worker role: ClickHouse sink, profile workers, journeys, e-mail delivery');
  return [
    run('clickhouse-sink', runSink(srv.bus, srv.events, signal)),
    run('journey-sweeper', runSweeper(srv.db, { kp: srv.keyProvider, events: srv.events }, signal)),
    run('email-delivery', runDeliveryWorker(srv.db, { kp: srv.keyProvider, events: srv.events, email: srv.email }, signal)),
    ...runProfileWorkers(
      {
        bus: srv.bus,
        db: srv.db,
        kp: srv.keyProvider,
        after: [
          segmentHook({ db: srv.db, events: srv.events, bus: srv.bus }),
          snapshotHook({ db: srv.db, hot: srv.hot }),
          journeyHook(srv.db),
        ],
      },
      signal,
    ).map((p, i) => run(`profiles-${i}`, p)),
  ];
}
