import { migrateAuth } from '@agentic-marketing/auth';
import { migrate, migrationFiles } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { initTelemetry, logger, shutdownTelemetry } from '@agentic-marketing/telemetry';
import { serve } from '@hono/node-server';
import { createServer } from './app';
import { ConfigError, loadConfig } from './config';
import { publicOnly } from './http/public-only';
import { createBackup, keepDaysFromEnv } from './ops/backup-lib';
import { offlineChecks } from './ops/checks';
import { COMMIT, VERSION } from './version';
import { startScheduler, startWorkers } from './workers';

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
const { app, db } = srv;
if (!config.skipMigrations) {
  await preUpgradeBackup(db, config);
  await migrate(db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole, log: (m) => logger.info(m) });
  await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db });
  await migrateClickHouse(config.clickhouse.url, config.clickhouse.database, (m) => logger.info(m), config.clickhouse);
}

const servers: { close: () => void }[] = [];
if (config.roles.has('api') || config.roles.has('ingest')) {
  servers.push(
    serve({ fetch: app.fetch, port: config.port }, () => logger.info({ url: config.publicUrl, roles: [...config.roles] }, 'api listening')),
  );
}
// Optional public edge: only the form, link and webhook routes, so a tunnel needs no path rule.
if (config.publicPort && (config.roles.has('api') || config.roles.has('ingest'))) {
  servers.push(
    serve({ fetch: publicOnly(app).fetch, port: config.publicPort }, () =>
      logger.info({ port: config.publicPort }, 'public listener started'),
    ),
  );
}
const stopWorkers = new AbortController();
const workers = [
  ...(config.roles.has('worker') ? startWorkers(srv, stopWorkers.signal) : []),
  ...(config.roles.has('scheduler') ? startScheduler(srv, stopWorkers.signal) : []),
];

const shutdown = async () => {
  logger.info('shutting down');
  for (const s of servers) s.close();
  stopWorkers.abort();
  await Promise.allSettled(workers);
  await srv.bus.close();
  await srv.events.close();
  await srv.hot.close();
  await db.close();
  await shutdownTelemetry();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
      keepDays: keepDaysFromEnv(),
      log: (message) => logger.info(message),
    });
    logger.info({ path: dir }, 'pre-upgrade backup written (set SKIP_PRE_UPGRADE_BACKUP=true to skip it)');
  } catch (err) {
    logger.warn({ reason: (err as Error).message }, 'pre-upgrade backup skipped; migrations continue');
  }
}
