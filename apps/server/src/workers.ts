import { clickIdHook, conversionHook, runAudienceSyncs, runSpendImport } from '@agentic-marketing/ads';
import { runAiWorker } from '@agentic-marketing/ai';
import { runAlertEvaluator } from '@agentic-marketing/alerts';
import { consentHook, runBroadcasts, runRetention } from '@agentic-marketing/audience';
import { cleanupExpiredOAuthWorkspaceSelections, RESET_PASSWORD_TTL_SECONDS } from '@agentic-marketing/auth';
import { runContentFetches } from '@agentic-marketing/content';
import { type Db, runSentAtBackfill } from '@agentic-marketing/db';
import { runDeliveryWorker } from '@agentic-marketing/email';
import { runSink } from '@agentic-marketing/events';
import { type DeliveryDeps, runDeliveries, runTokenRefresher, webhookHook } from '@agentic-marketing/integrations';
import { journeyHook, runEnrollmentJobs, runSweeper } from '@agentic-marketing/journeys';
import { refreshSnapshots, runEdgeSync, snapshotHook } from '@agentic-marketing/personalize';
import { runProfileWorkers } from '@agentic-marketing/profiles';
import { runSegmentScheduler, segmentHook } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import { runWarehouseExports } from '@agentic-marketing/warehouse';
import { runAgentEvents } from './agents/events';
import { runGuardian } from './agents/guardian';
import { runHolds } from './agents/holds';
import { runHostedAgents } from './agents/hosted';
import { runAgentNotifications } from './agents/notifications';
import { runExperienceRollouts } from './agents/rollouts';
import type { createServer } from './app';
import { runPasswordResetDeliveries } from './passwordReset';

/** The cross-tenant sweep of abandoned OAuth consent choices (#838). */
export const OAUTH_SELECTION_CLEANUP_TASK = 'oauth-workspace-selections.cleanup';
/** Hourly is plenty: a choice lives for a day and is consumed by its own consent flow. */
export const OAUTH_SELECTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The scheduler's recurring sweep of pending OAuth workspace choices nobody came back for. It is
 * deliberately cross-tenant, so it runs here (as the owner), never in a request.
 */
export function runOAuthSelectionCleanup(db: Db, signal: AbortSignal, opts: { tickMs?: number } = {}): Promise<void> {
  const tickMs = opts.tickMs ?? OAUTH_SELECTION_CLEANUP_INTERVAL_MS;
  return new Promise((resolve) => {
    let stopped = false;
    let running = false;
    const sweep = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const removed = await cleanupExpiredOAuthWorkspaceSelections(db);
        if (removed) logger.info({ removed, task: OAUTH_SELECTION_CLEANUP_TASK }, 'dropped expired OAuth workspace choices');
      } catch (err) {
        logger.warn({ err }, 'the OAuth workspace choice cleanup failed');
      } finally {
        running = false;
      }
    };
    void sweep();
    const timer = setInterval(() => void sweep(), tickMs);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      resolve();
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
  });
}

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
    agentEventTickMs?: number;
    hostedAgentTickMs?: number;
    guardianTickMs?: number;
    contentTickMs?: number;
    enrollmentTickMs?: number;
    rolloutTickMs?: number;
  } = {},
): Promise<void>[] {
  logger.info(
    'scheduler role: segment recomputation, broadcasts, retention, OAuth token refresh, audience sync, ad spend import, warehouse exports, edge sync, threshold alerts, held agent changes, agent notifications, agent events, hosted agents, content sources, segment enrollment jobs, experience rollouts, sent_at backfill, expired OAuth choices',
  );
  return [
    // One pass at start: an abandoned consent choice is short-lived, and nothing in the request
    // path may sweep across tenants (#838).
    runOAuthSelectionCleanup(srv.db, signal),
    // One pass at start: the 0.10.1 migration only adds the column; this fills completed rows in
    // short batches while sends continue, and stops when every row has its send time (#453).
    runSentAtBackfill({ db: srv.db }, signal, {
      log: (message) => logger.info(message),
      onError: (err) => logger.error({ err }, 'sent_at backfill failed'),
    }),
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
    runGuardian(
      { db: srv.db, services: srv.services, kp: srv.keyProvider, email: srv.email, directory: srv.directory, publicUrl: srv.publicUrl },
      signal,
      { tickMs: opts.guardianTickMs },
    ),
    runAgentNotifications(
      { db: srv.db, kp: srv.keyProvider, email: srv.email, directory: srv.directory, publicUrl: srv.publicUrl },
      signal,
      { tickMs: opts.agentNotifyTickMs },
    ),
    runAgentEvents({ db: srv.db }, signal, { tickMs: opts.agentEventTickMs }),
    runContentFetches({ db: srv.db, egress: srv.egress }, signal, { tickMs: opts.contentTickMs }),
    runEnrollmentJobs({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal, { tickMs: opts.enrollmentTickMs }),
    runExperienceRollouts(
      {
        db: srv.db,
        events: srv.events,
        hot: srv.hot,
        kp: srv.keyProvider,
        email: srv.email,
        directory: srv.directory,
        publicUrl: srv.publicUrl,
      },
      signal,
      { tickMs: opts.rolloutTickMs },
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
  opts: { deliveries?: Pick<DeliveryDeps, 'webhookBackoffMs' | 'actionBackoffMs'>; passwordResetTickMs?: number } = {},
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
    run('ai-steps', runAiWorker(srv.db, { kp: srv.keyProvider, events: srv.events, egress: srv.egress }, signal)),
    run('deliveries', runDeliveries(srv.db, { kp: srv.keyProvider, egress: srv.egress, hot: srv.hot, ...opts.deliveries }, signal)),
    run('email-delivery', runDeliveryWorker(srv.db, { kp: srv.keyProvider, events: srv.events, email: srv.email }, signal)),
    run(
      'password-reset-delivery',
      runPasswordResetDeliveries(
        {
          db: srv.db,
          kp: srv.keyProvider,
          email: srv.email,
          directory: srv.directory,
          publicUrl: srv.publicUrl,
          ttlSeconds: RESET_PASSWORD_TTL_SECONDS,
          secret: srv.authSecret,
          auth: srv.auth,
        },
        signal,
        { tickMs: opts.passwordResetTickMs },
      ),
    ),
    ...runProfileWorkers(
      {
        bus: srv.bus,
        db: srv.db,
        kp: srv.keyProvider,
        erasureGraceHours: srv.erasureGraceHours,
        after: [
          // Consent first: segments and journeys that react to a signup need it recorded.
          consentHook({
            db: srv.db,
            kp: srv.keyProvider,
            events: srv.events,
            links: srv.email.links,
            linksUrl: srv.linksUrl,
            linksUrlFor: (workspaceId) => srv.domains.linksUrlFor(workspaceId),
          }),
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
