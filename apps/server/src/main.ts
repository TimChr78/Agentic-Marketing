import { migrateAuth } from '@agentic-marketing/auth';
import { migrate } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { initTelemetry, logger, shutdownTelemetry } from '@agentic-marketing/telemetry';
import { serve } from '@hono/node-server';
import { createServer } from './app';
import { loadConfig } from './config';
import { publicOnly } from './http/public-only';
import { startScheduler, startWorkers } from './workers';

// One image, several roles (ADR-0002): `api` (UI, REST, MCP), `ingest` (event collection),
// `worker` (event consumers) and `scheduler` (arrives with the journey runtime).
const config = loadConfig();
initTelemetry('agentic-marketing');

const srv = createServer(config);
const { app, db } = srv;
if (!config.skipMigrations) {
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
