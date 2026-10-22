import { createAuth } from '@agentic-marketing/auth';
import { createExecutor } from '@agentic-marketing/commands';
import { AppError, newUuid } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { Hono } from 'hono';
import type { Config } from './config';
import { mcpEndpoint } from './http/mcp';
import { consentPage, loginPage } from './http/pages';
import { restApi } from './http/rest';

export function createServer(config: Config) {
  const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  const auth = createAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db, trustedOrigins: config.trustedOrigins });
  const executor = createExecutor(db, { keyProvider: localKeyProvider(config.masterKey) });

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    const requestId = newUuid();
    logger.error({ err, requestId, path: c.req.path }, 'unhandled error');
    return c.json({ error: 'internal', message: 'Something went wrong on our side.', requestId }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await db.ping();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // OAuth discovery at the root, where MCP clients look (RFC 8414 path insertion included). The MCP
  // plugin answers RFC 9728 protected-resource metadata itself when the root path reaches it.
  const asMeta = oauthProviderAuthServerMetadata(auth);
  const oidcMeta = oauthProviderOpenIdConfigMetadata(auth);
  app.get('/.well-known/oauth-authorization-server', (c) => asMeta(c.req.raw));
  app.get('/.well-known/oauth-authorization-server/*', (c) => asMeta(c.req.raw));
  app.get('/.well-known/openid-configuration', (c) => oidcMeta(c.req.raw));
  app.get('/.well-known/openid-configuration/*', (c) => oidcMeta(c.req.raw));
  app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(c.req.raw));
  app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(c.req.raw));

  app.get('/login', (c) => c.html(loginPage));
  app.get('/consent', (c) => c.html(consentPage));

  const mcp = mcpEndpoint({ auth, db, executor, resource: `${config.publicUrl}/mcp` });
  app.all('/mcp', (c) => mcp(c.req.raw));
  app.route('/', restApi({ auth, db, executor }));

  return { app, db, auth, executor };
}
