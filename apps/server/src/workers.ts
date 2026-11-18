import { clickIdHook, conversionHook, runAudienceSyncs, runSpendImport } from '@agentic-marketing/ads';
import { runAiWorker } from '@agentic-marketing/ai';
import { runAlertEvaluator } from '@agentic-marketing/alerts';
import { runActiveMandateRepair, runArchivedApprovalSweep } from '@agentic-marketing/artifacts';
import { consentHook, runBroadcasts, runOutboxDispatcher, runRetention } from '@agentic-marketing/audience';
import { cleanupExpiredOAuthWorkspaceSelections, RESET_PASSWORD_TTL_SECONDS } from '@agentic-marketing/auth';
import { runContentFetches } from '@agentic-marketing/content';
import { type Db, runIdempotencyKeyCleanup, runSentAtBackfill } from '@agentic-marketing/db';
import { runDeliveryWorker } from '@agentic-marketing/email';
import { runSink, runSubjectKeyBackfill } from '@agentic-marketing/events';
import { type DeliveryDeps, runDeliveries, runTokenRefresher, webhookHook } from '@agentic-marketing/integrations';
import { journeyHook, runEnrollmentJobs, runSweeper } from '@agentic-marketing/journeys';
import { refreshSnapshots, runEdgeSync, snapshotHook } from '@agentic-marketing/personalize';
import { erasedEventFilter, runErasureCleanup, runProfileWorkers } from '@agentic-marketing/profiles';
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
 * A worker loop's promise, labelled with the loop's name, so a shutdown that waits for it can say
 * which one is still running instead of hanging silently (#1028). The label carries no tenant data.
 */
export type WorkerLoop = Promise<void> & { readonly worker: string };

function loop(name: string, task: Promise<void>): WorkerLoop {
  return Object.assign(task, { worker: name });
}

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
    idempotencyCleanupTickMs?: number;
    /** How long the erasure cleanup waits before its final ClickHouse re-sweep. */
    erasureFinalSweepMs?: number;
    /** False keeps the erasure cleanup loop out of the way; a test drives its rounds itself. */
    erasureCleanup?: boolean;
  } = {},
): WorkerLoop[] {
  logger.info(
    'scheduler role: segment recomputation, broadcasts, the transactional outbox, erasure cleanup, retention, OAuth token refresh, audience sync, ad spend import, warehouse exports, edge sync, threshold alerts, held agent changes, agent notifications, agent events, hosted agents, content sources, segment enrollment jobs, experience rollouts, sent_at backfill, subject-key backfill, expired OAuth choices, expired idempotency keys',
  );
  return [
    // One pass at start: an abandoned consent choice is short-lived, and nothing in the request
    // path may sweep across tenants (#838).
    loop('oauth-selection-cleanup', runOAuthSelectionCleanup(srv.db, signal)),
    // One pass at start: the 0.10.1 migration only adds the column; this fills completed rows in
    // short batches while sends continue, and stops when every row has its send time (#453).
    loop(
      'sent-at-backfill',
      runSentAtBackfill({ db: srv.db }, signal, {
        log: (message) => logger.info(message),
        onError: (err) => logger.error({ err }, 'sent_at backfill failed'),
      }),
    ),
    // One pass at start: fills the subject-key columns of rows written before #1037 part 1, one
    // ClickHouse partition at a time. Nothing reads the columns yet, but the contract's later part
    // needs them for every historical row.
    loop(
      'subject-key-backfill',
      runSubjectKeyBackfill({ events: srv.events }, signal, {
        log: (message) => logger.info(message),
        onError: (err) => logger.error({ err }, 'subject-key backfill failed'),
      }),
    ),
    // The idempotency-key retention pass (#976): one pass at start, then periodically. It runs as
    // the owner in bounded batches with SKIP LOCKED, so several schedulers can share the work.
    loop(
      'idempotency-key-cleanup',
      runIdempotencyKeyCleanup({ db: srv.db }, signal, {
        retentionDays: srv.idempotencyRetentionDays,
        tickMs: opts.idempotencyCleanupTickMs,
        log: (message) => logger.info(message),
        onError: (err) => logger.error({ err }, 'idempotency key cleanup failed'),
      }),
    ),
    // One pass at start: the single-active-mandate repair (#911) keeps the mandate the runtime
    // uses and archives legacy duplicates; it needs the runtime's schema check, so it is code.
    loop(
      'mandate-repair',
      runActiveMandateRepair({ db: srv.db }, signal, {
        log: (message) => logger.info(message),
        onError: (err) => logger.error({ err }, 'single active mandate repair failed'),
      }),
    ),
    // One pass at start, then every few hours: a request that names an archived artifact can never
    // publish, so it is closed as rejected instead of sitting in the queue (#957).
    loop(
      'archived-approval-sweep',
      runArchivedApprovalSweep({ db: srv.db }, signal, {
        log: (message) => logger.info(message),
        onError: (err) => logger.error({ err }, 'archived approval sweep failed'),
      }),
    ),
    loop(
      'segments',
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
    ),
    loop('broadcasts', runBroadcasts({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal, opts.broadcastTickMs)),
    // Post-commit work enqueued by tenant transactions (#978 part 2): message events and DOI
    // confirmation sends. It runs across tenants, as the owner, and claims with SKIP LOCKED.
    loop('outbox-dispatcher', runOutboxDispatcher({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal)),
    loop(
      'retention',
      runRetention({ db: srv.db, events: srv.events, hot: srv.hot, ...srv.retention, erasureGraceHours: srv.erasureGraceHours }, signal),
    ),
    ...(opts.erasureCleanup === false
      ? []
      : [
          // External erasure cleanup (#978 part 2b): ClickHouse and hot state, after the erasure's SQL
          // transaction committed. It waits for an in-flight outbox publisher of the erased person, then
          // sweeps ClickHouse immediately and again after the ClickHouse request-timeout bound before
          // completing.
          loop(
            'erasure-cleanup',
            runErasureCleanup({ db: srv.db, kp: srv.keyProvider, events: srv.events, hot: srv.hot }, signal, {
              ...(opts.erasureFinalSweepMs === undefined ? {} : { finalSweepMs: opts.erasureFinalSweepMs }),
            }),
          ),
        ]),
    loop('oauth-token-refresh', runTokenRefresher({ db: srv.db, kp: srv.keyProvider, egress: srv.egress }, signal)),
    loop('audience-syncs', runAudienceSyncs({ db: srv.db, kp: srv.keyProvider, egress: srv.egress }, signal)),
    loop('spend-import', runSpendImport({ db: srv.db, events: srv.events, kp: srv.keyProvider, egress: srv.egress }, signal)),
    loop(
      'warehouse-exports',
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
    ),
    loop('edge-sync', runEdgeSync({ db: srv.db, hot: srv.hot, kp: srv.keyProvider, egress: srv.egress, tickMs: opts.edgeTickMs }, signal)),
    loop(
      'alerts',
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
    ),
    loop('holds', runHolds({ db: srv.db, services: srv.services }, signal, opts.holdTickMs)),
    loop(
      'guardian',
      runGuardian(
        { db: srv.db, services: srv.services, kp: srv.keyProvider, email: srv.email, directory: srv.directory, publicUrl: srv.publicUrl },
        signal,
        { tickMs: opts.guardianTickMs },
      ),
    ),
    loop(
      'agent-notifications',
      runAgentNotifications(
        { db: srv.db, kp: srv.keyProvider, email: srv.email, directory: srv.directory, publicUrl: srv.publicUrl },
        signal,
        { tickMs: opts.agentNotifyTickMs },
      ),
    ),
    loop('agent-events', runAgentEvents({ db: srv.db }, signal, { tickMs: opts.agentEventTickMs })),
    loop('content-sources', runContentFetches({ db: srv.db, egress: srv.egress }, signal, { tickMs: opts.contentTickMs })),
    loop(
      'enrollment-jobs',
      runEnrollmentJobs({ db: srv.db, kp: srv.keyProvider, events: srv.events }, signal, { tickMs: opts.enrollmentTickMs }),
    ),
    loop(
      'experience-rollouts',
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
    ),
    loop(
      'hosted-agents',
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
    ),
  ];
}

/** Event consumers of the worker role. Each runs until `signal` aborts. */
export function startWorkers(
  srv: ReturnType<typeof createServer>,
  signal: AbortSignal,
  opts: { deliveries?: Pick<DeliveryDeps, 'webhookBackoffMs' | 'actionBackoffMs'>; passwordResetTickMs?: number } = {},
): WorkerLoop[] {
  const run = (name: string, p: Promise<void>) =>
    loop(
      name,
      p.catch((err) => {
        logger.error({ err, worker: name }, 'worker stopped');
        throw err;
      }),
    );
  logger.info('worker role: ClickHouse sink, profile workers, journeys, AI steps, e-mail, webhooks and actions');
  return [
    run(
      'clickhouse-sink',
      runSink(srv.bus, srv.events, signal, {
        // An event still on the bus when its person is erased, or one that arrives inside the
        // grace window, must not be stored. This is the mitigation's new-write guard (#1037).
        filter: erasedEventFilter({ db: srv.db, kp: srv.keyProvider, graceHours: srv.erasureGraceHours }),
      }),
    ),
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
