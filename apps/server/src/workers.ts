import { runAiWorker } from '@agentic-marketing/ai';
import { consentHook, runBroadcasts } from '@agentic-marketing/audience';
import { runDeliveryWorker } from '@agentic-marketing/email';
import { runSink } from '@agentic-marketing/events';
import { type DeliveryDeps, runDeliveries, webhookHook } from '@agentic-marketing/integrations';
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
  opts: { segmentTickMs?: number; broadcastTickMs?: number } = {},
): Promise<void>[] {
  logger.info('scheduler role: segment recomputation, broadcasts');
  return [
    runSegmentScheduler({ db: srv.db, events: srv.events, bus: srv.bus, tickMs: opts.segmentTickMs }, signal),
    runBroadcasts({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal, opts.broadcastTickMs),
  ];
}

/** Event consumers of the worker role. Each runs until `signal` aborts. */
export function startWorkers(
  srv: ReturnType<typeof createServer>,
  signal: AbortSignal,
  opts: { deliveries?: Pick<DeliveryDeps, 'webhookBackoffMs' | 'actionBackoffMs'> } = {},
): Promise<void>[] {
  const run = (name: string, p: Promise<void>) =>
    p.catch((err) => {
      logger.error({ err, worker: name }, 'worker stopped');
      throw err;
    });
  logger.info('worker role: ClickHouse sink, profile workers, journeys, AI steps, e-mail, webhooks and actions');
  return [
    run('clickhouse-sink', runSink(srv.bus, srv.events, signal)),
    run('journey-sweeper', runSweeper(srv.db, { kp: srv.keyProvider, events: srv.events }, signal)),
    run('ai-steps', runAiWorker(srv.db, { kp: srv.keyProvider, events: srv.events }, signal)),
    run('deliveries', runDeliveries(srv.db, { kp: srv.keyProvider, egress: srv.egress, ...opts.deliveries }, signal)),
    run('email-delivery', runDeliveryWorker(srv.db, { kp: srv.keyProvider, events: srv.events, email: srv.email }, signal)),
    ...runProfileWorkers(
      {
        bus: srv.bus,
        db: srv.db,
        kp: srv.keyProvider,
        after: [
          // Consent first: segments and journeys that react to a signup need it recorded.
          consentHook({ db: srv.db, kp: srv.keyProvider, events: srv.events, links: srv.email.links, linksUrl: srv.linksUrl }),
          segmentHook({ db: srv.db, events: srv.events, bus: srv.bus }),
          snapshotHook({ db: srv.db, hot: srv.hot }),
          journeyHook(srv.db),
          webhookHook(srv.db),
        ],
      },
      signal,
    ).map((p, i) => run(`profiles-${i}`, p)),
  ];
}
