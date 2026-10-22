import { migrateAuth } from '@agentic-marketing/auth';
import { migrate } from '@agentic-marketing/db';
import { initTelemetry, logger, shutdownTelemetry } from '@agentic-marketing/telemetry';
import { serve } from '@hono/node-server';
import { createServer } from './app';
import { loadConfig } from './config';

// One image, several roles (ADR-0002). Phase 0 implements `api`; `worker` and `scheduler` arrive
// with the data platform and journey runtime.
const config = loadConfig();
initTelemetry('agentic-marketing');

const { app, db, auth } = createServer(config);
await migrate(db.admin, { appRolePassword: config.appDbPassword, log: (m) => logger.info(m) });
await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db });
void auth;

const servers: { close: () => void }[] = [];
if (config.roles.has('api')) {
  servers.push(
    serve({ fetch: app.fetch, port: config.port }, () => logger.info({ url: config.publicUrl, roles: [...config.roles] }, 'api listening')),
  );
}
for (const role of ['worker', 'scheduler']) if (config.roles.has(role)) logger.info(`${role} role has nothing to run yet (Phase 1+)`);

const shutdown = async () => {
  logger.info('shutting down');
  for (const s of servers) s.close();
  await db.close();
  await shutdownTelemetry();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
