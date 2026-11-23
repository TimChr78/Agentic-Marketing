import { migrateAuth } from '@agentic-marketing/auth';
import { migrate, migrationFiles, recordServerVersion } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { endpointLocation, initTelemetry, logger, shutdownTelemetry } from '@agentic-marketing/telemetry';
import { serve } from '@hono/node-server';
import { createServer } from './app';
import { ConfigError, loadConfig } from './config';
import { prefixOf } from './domains';
import { publicOnly } from './http/public-only';
import { createBackup, keepDaysFromEnv, stopRestoreChildren } from './ops/backup-lib';
import { offlineChecks } from './ops/checks';
import { acquireRestoreStartupLock } from './ops/restore-reconcile';
import { createShutdown, drainHttpServers, drainWorkers, HTTP_DRAIN_TIMEOUT_MS, type HttpListener } from './shutdown';
import { COMMIT, VERSION } from './version';
import { startScheduler, startWorkers } from './workers';
import { writerProtocolMismatch } from './writerProtocol';

// One image, several roles (ADR-0002): `api` (UI, REST, MCP), `ingest` (event collection),
// `worker` (event consumers) and `scheduler` (arrives with the journey runtime).
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // A container log should say what to fix, not show a stack from loadConfig.
  console.error(err.message);
  process.exit(1);
}
initTelemetry('agentic-marketing');
logger.info({ version: VERSION, commit: COMMIT }, 'agentic-marketing starting');
// The offline part of `am doctor`, as warnings: a diagnostic never keeps the server from starting.
try {
  for (const check of offlineChecks(process.env)) {
    if (check.status !== 'ok') logger.warn({ check: check.id, hint: check.hint }, check.message);
  }
} catch (err) {
  logger.warn({ err }, 'startup configuration checks failed');
}

const srv = createServer(config);
const { app, db, requestAborts } = srv;

// The restore interlock (#1194 review): every server process takes the restore advisory lock
// shared on a dedicated connection *before* its first migration, reads the fence under that lock
// and keeps both until shutdown. A restore holds the same lock exclusively for its whole run, so
// this refuses to start while one is in progress; a raised fence refuses too. Taking it before the
// migrations is what keeps a restore from replacing the schema under a starting process, and
// keeping it means a restore cannot start while any role is still serving, even with idle pools.
// If the lock connection is lost, the process exits: without the lock it can no longer prove the
// interlock, and a supervisor restarts it (which re-acquires the lock or refuses on the fence).
let restoreLock: Awaited<ReturnType<typeof acquireRestoreStartupLock>>;
try {
  restoreLock = await acquireRestoreStartupLock(config.adminDatabaseUrl, {
    onLost: (err) => {
      logger.error({ reason: err.message }, 'the restore lock connection was lost; exiting so no read is served without it');
      // A pre-upgrade `pg_dump` started by this process must not outlive the interlock (#1204
      // review). Wait for it to be gone (SIGTERM, then SIGKILL) before exiting: exiting first let an
      // ignored SIGTERM keep the child alive.
      void stopRestoreChildren().then(
        () => process.exit(1),
        () => process.exit(1),
      );
    },
  });
} catch (err) {
  logger.error((err as Error).message);
  process.exit(1);
}
if (!config.skipMigrations) {
  await preUpgradeBackup(db, config);
  await migrate(db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole, log: (m) => logger.info(m) });
  await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db });
  await migrateClickHouse(config.clickhouse.url, config.clickhouse.database, (m) => logger.info(m), config.clickhouse);
}

// The writer protocol marker (#1066): refuse to start beside a database that expects a newer
// writer protocol. The drain is documented in UPGRADING.md; this makes a rollback or a mistaken
// mixed rollout fail fast instead of interleaving two protocol versions.
const protocolProblem = await writerProtocolMismatch(db.admin);
if (protocolProblem) {
  logger.error(protocolProblem);
  process.exit(1);
}

// A restore raises its fence before replacing Postgres and clears it only once the restored
// erasure ledger is visible in ClickHouse, while holding the restore lock exclusively (#1194).
// The fence was already checked under the startup lock above; serving in either state could pair
// a complete erasure with a ClickHouse point that never saw its exclusions, so that check happens
// before any listener opens. Rerunning `am restore` completes the reconciliation;
// `am restore --clear-fence` abandons it deliberately.

// The version this database last ran, so the next pre-upgrade backup knows where its data came from.
// Also with SKIP_MIGRATIONS (a migration job ran first); never a reason not to start.
await recordServerVersion(db.admin, VERSION).catch((err) =>
  logger.warn({ reason: (err as Error).message }, 'could not record the server version'),
);

const servers: HttpListener[] = [];
if (config.roles.has('api') || config.roles.has('ingest')) {
  servers.push(
    serve({ fetch: app.fetch, port: config.port }, () =>
      // PUBLIC_URL may hold userinfo or a token in its query; the log gets the origin and path.
      logger.info({ url: endpointLocation(config.publicUrl), roles: [...config.roles] }, 'api listening'),
    ),
  );
}
// Optional public edge: only the form, link and webhook routes, so a tunnel needs no path rule.
if (config.publicPort && (config.roles.has('api') || config.roles.has('ingest'))) {
  servers.push(
    serve({ fetch: publicOnly(app, prefixOf(srv.domains)).fetch, port: config.publicPort }, () =>
      logger.info({ port: config.publicPort }, 'public listener started'),
    ),
  );
}
const stopWorkers = new AbortController();
const workers = [
  ...(config.roles.has('worker') ? startWorkers(srv, stopWorkers.signal) : []),
  ...(config.roles.has('scheduler') ? startScheduler(srv, stopWorkers.signal) : []),
];

// Stop accepting traffic first, then drain the workers, then close the pools and clients. Every
// step runs even when an earlier one fails; the exit code says whether anything was left behind.
// The http step waits, bounded, for the requests already being answered (#1059), so a request in
// flight finishes before the workers, pools and clients that serve it close underneath it.
const shutdown = createShutdown({
  log: logger,
  exit: (code) => process.exit(code),
  steps: [
    {
      name: 'http',
      close: () => drainHttpServers(servers, HTTP_DRAIN_TIMEOUT_MS, { aborts: requestAborts }),
    },
    {
      name: 'workers',
      close: () => {
        stopWorkers.abort();
        return drainWorkers(workers);
      },
    },
    { name: 'bus', close: () => srv.bus.close() },
    { name: 'events', close: () => srv.events.close() },
    { name: 'hotstate', close: () => srv.hot.close() },
    { name: 'database', close: () => db.close() },
    // Release the restore interlock last: the pools are closed, the workers are drained, and no
    // request can still be served. Holding it any longer would only delay an operator's restore.
    { name: 'restore-lock', close: () => restoreLock.release() },
    { name: 'telemetry', close: () => shutdownTelemetry() },
  ],
});
process.on('SIGTERM', shutdown.onSignal);
process.on('SIGINT', shutdown.onSignal);

/**
 * A dump before migrations change the schema, so an upgrade can always go back. It must never
 * block a start: development machines usually have no pg_dump, and a read-only directory should
 * only warn. Only databases that already carry a migration head need one.
 */
async function preUpgradeBackup(db: ReturnType<typeof createServer>['db'], config: ReturnType<typeof loadConfig>) {
  if (config.skipPreUpgradeBackup) return;
  try {
    const present = await db.admin.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return;
    const { rows } = await db.admin.query<{ version: string }>('SELECT version FROM schema_migrations');
    if (!rows.length) return;
    const applied = new Set(rows.map((row) => row.version));
    if (migrationFiles().every((file) => applied.has(file))) return;

    const { dir } = await createBackup({
      dir: config.backupDir,
      databaseUrl: config.adminDatabaseUrl,
      kind: 'pre-upgrade',
      keepDays: keepDaysFromEnv(),
      log: (message) => logger.info(message),
    });
    logger.info({ path: dir }, 'pre-upgrade backup written (set SKIP_PRE_UPGRADE_BACKUP=true to skip it)');
  } catch (err) {
    logger.warn({ reason: (err as Error).message }, 'pre-upgrade backup skipped; migrations continue');
  }
}
