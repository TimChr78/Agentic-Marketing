import { formsApi } from '@agentic-marketing/audience';
import { type AuthConfig, acceptInvitation, authDirectory, createAuth, invitationWorkspace } from '@agentic-marketing/auth';
import { createExecutor, userPrincipal } from '@agentic-marketing/commands';
import { AppError, newUuid } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { emailRoutes, linkSigner } from '@agentic-marketing/email';
import { clickHouseStore, lazyNatsBus } from '@agentic-marketing/events';
import { valkeyHotState } from '@agentic-marketing/hotstate';
import { ingestApi } from '@agentic-marketing/ingest';
import { inboundApi } from '@agentic-marketing/integrations';
import { decideApi } from '@agentic-marketing/personalize';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { Hono } from 'hono';
import type { Config } from './config';
import { copilotApi } from './http/copilot';
import { mcpEndpoint } from './http/mcp';
import { consentPage, invitePage, loginPage } from './http/pages';
import { restApi } from './http/rest';

/** `overrides` exist for tests, e.g. a stub transport for Client ID Metadata Documents. */
export function createServer(config: Config, overrides: Pick<AuthConfig, 'cimd'> = {}) {
  const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  const auth = createAuth({
    baseUrl: config.publicUrl,
    secret: config.authSecret,
    db,
    trustedOrigins: config.trustedOrigins,
    ...overrides,
  });
  const keyProvider = localKeyProvider(config.masterKey, config.previousMasterKeys);
  const bus = lazyNatsBus(config.nats);
  const events = clickHouseStore(config.clickhouse);
  const hot = valkeyHotState(config.valkey);
  const email = {
    publicUrl: config.linksUrl,
    links: linkSigner(config.authSecret),
    adapterDeps: { fetch: globalThis.fetch },
    trackClicks: config.trackClicks,
  };
  const executor = createExecutor(db, { keyProvider, directory: authDirectory(db), events, bus, email, hot, egress: config.egress });

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
      if (!(await events.ping())) throw new Error('ClickHouse is not reachable');
      if (!(await hot.ping())) throw new Error('Valkey is not reachable');
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
  app.get('/invite', (c) => c.html(invitePage));

  // Accepting an invitation: the person is signed in but not yet a member, so the workspace comes
  // from the token rather than from their memberships.
  app.post('/api/invitations/accept', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new AppError('unauthorized', 'Sign in (or create an account) with the invited e-mail address first.');
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const inv = typeof token === 'string' ? await invitationWorkspace(db, token) : null;
    if (!inv) throw new AppError('not_found', 'This invitation link is not valid any more. Ask for a new one.');
    // Accepting needs no permission; the principal carries none until the membership exists.
    const invitee = { ...userPrincipal(session.user.id, inv.workspaceId, inv.role), permissions: new Set<never>() };
    const out = await executor.execute(acceptInvitation, { token, email: session.user.email }, invitee, { surface: 'rest' });
    return c.json(out);
  });

  // The decision API goes first: the ingest routes claim every other /v1/<word> path.
  if (config.roles.has('ingest')) app.route('/', decideApi({ db, hot }));
  if (config.roles.has('ingest')) app.route('/', ingestApi({ db, bus, hot, clientIpHeader: config.clientIpHeader }));
  if (config.roles.has('api')) app.route('/', emailRoutes({ db, kp: keyProvider, events, email }));
  if (config.roles.has('ingest')) app.route('/', inboundApi({ db, bus, kp: keyProvider }));
  if (config.roles.has('ingest'))
    app.route(
      '/',
      formsApi({ db, bus, kp: keyProvider, links: email.links, egress: config.egress, clientIpHeader: config.clientIpHeader }),
    );

  const mcp = mcpEndpoint({ auth, db, executor, resource: `${config.publicUrl}/mcp` });
  app.all('/mcp', (c) => mcp(c.req.raw));
  if (config.roles.has('api')) app.route('/', copilotApi({ auth, db, executor, kp: keyProvider }));
  app.route('/', restApi({ auth, db, executor }));

  return { app, db, auth, executor, keyProvider, bus, events, email, hot, egress: config.egress, linksUrl: config.linksUrl };
}
