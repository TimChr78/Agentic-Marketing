import { clickIdHook, conversionHook, runAudienceSyncs, runSpendImport } from '@agentic-marketing/ads';
import { runAiWorker } from '@agentic-marketing/ai';
import { runAlertEvaluator } from '@agentic-marketing/alerts';
import { consentHook, runBroadcasts, runRetention } from '@agentic-marketing/audience';
import { runDeliveryWorker } from '@agentic-marketing/email';
import { runSink } from '@agentic-marketing/events';
import { type DeliveryDeps, runDeliveries, runTokenRefresher, webhookHook } from '@agentic-marketing/integrations';
import { journeyHook, runSweeper } from '@agentic-marketing/journeys';
import { refreshSnapshots, runEdgeSync, snapshotHook } from '@agentic-marketing/personalize';
import { runProfileWorkers } from '@agentic-marketing/profiles';
import { runSegmentScheduler, segmentHook } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import { runWarehouseExports } from '@agentic-marketing/warehouse';
import { runHolds } from './agents/holds';
import { runHostedAgents } from './agents/hosted';
import { runAgentNotifications } from './agents/notifications';
import type { createServer } from './app';

/** Periodic jobs of the scheduler role. */
export function startScheduler(
  srv: ReturnType<typeof createServer>,
  signal: AbortSignal,
  opts: {
    segmentTickMs?: number;
    broadcastTickMs?: number;
    warehouseTickMs?: number;
    warehouseLagMs?: number;
    edgeTickMs?: number;
    alertTickMs?: number;
    holdTickMs?: number;
    agentNotifyTickMs?: number;
    hostedAgentTickMs?: number;
  } = {},
): Promise<void>[] {
  logger.info(
    'scheduler role: segment recomputation, broadcasts, retention, OAuth token refresh, audience sync, ad spend import, warehouse exports, edge sync, threshold alerts, held agent changes, agent notifications, hosted agents',
  );
  return [
    runSegmentScheduler(
      {
        db: srv.db,
        events: srv.events,
        bus: srv.bus,
        tickMs: opts.segmentTickMs,
        // Snapshots (what the decision API sees) follow a scheduled refresh at once.
        afterRefresh: (ws, people) => refreshSnapshots({ db: srv.db, hot: srv.hot }, ws, people),
      },
      signal,
    ),
    runBroadcasts({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal, opts.broadcastTickMs),
    runRetention({ db: srv.db, events: srv.events, hot: srv.hot, ...srv.retention, erasureGraceHours: srv.erasureGraceHours }, signal),
    runTokenRefresher({ db: srv.db, kp: srv.keyProvider, egress: srv.egress }, signal),
    runAudienceSyncs({ db: srv.db, kp: srv.keyProvider, egress: srv.egress }, signal),
    runSpendImport({ db: srv.db, events: srv.events, kp: srv.keyProvider, egress: srv.egress }, signal),
    runWarehouseExports(
      {
        db: srv.db,
        events: srv.events,
        kp: srv.keyProvider,
        egress: srv.egress,
        tickMs: opts.warehouseTickMs,
        lagMs: opts.warehouseLagMs,
      },
      signal,
    ),
    runEdgeSync({ db: srv.db, hot: srv.hot, kp: srv.keyProvider, egress: srv.egress, tickMs: opts.edgeTickMs }, signal),
    runAlertEvaluator(
      {
        db: srv.db,
        events: srv.events,
        kp: srv.keyProvider,
        email: srv.email,
        directory: srv.directory,
        publicUrl: srv.publicUrl,
      },
      signal,
      { tickMs: opts.alertTickMs },
    ),
    runHolds({ db: srv.db, services: srv.services }, signal, opts.holdTickMs),
    runAgentNotifications(
      { db: srv.db, kp: srv.keyProvider, email: srv.email, directory: srv.directory, publicUrl: srv.publicUrl },
      signal,
      { tickMs: opts.agentNotifyTickMs },
    ),
    runHostedAgents(
      {
        db: srv.db,
        executor: srv.executor,
        kp: srv.keyProvider,
        email: srv.email,
        directory: srv.directory,
        publicUrl: srv.publicUrl,
      },
      signal,
      { tickMs: opts.hostedAgentTickMs },
    ),
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
    run('deliveries', runDeliveries(srv.db, { kp: srv.keyProvider, egress: srv.egress, hot: srv.hot, ...opts.deliveries }, signal)),
    run('email-delivery', runDeliveryWorker(srv.db, { kp: srv.keyProvider, events: srv.events, email: srv.email }, signal)),
    ...runProfileWorkers(
      {
        bus: srv.bus,
        db: srv.db,
        kp: srv.keyProvider,
        erasureGraceHours: srv.erasureGraceHours,
        after: [
          // Consent first: segments and journeys that react to a signup need it recorded.
          consentHook({ db: srv.db, kp: srv.keyProvider, events: srv.events, links: srv.email.links, linksUrl: srv.linksUrl }),
          // Click ids before conversions, so a landing and its conversion in one batch match.
          clickIdHook({ db: srv.db }),
          conversionHook({ db: srv.db }),
          segmentHook({ db: srv.db, events: srv.events, bus: srv.bus }),
          snapshotHook({ db: srv.db, hot: srv.hot }),
          journeyHook(srv.db, { kp: srv.keyProvider, events: srv.events }),
          webhookHook(srv.db),
        ],
      },
      signal,
    ).map((p, i) => run(`profiles-${i}`, p)),
  ];
}
