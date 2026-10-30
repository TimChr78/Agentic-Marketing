import { existsSync } from 'node:fs';
import { activeMandate } from '@agentic-marketing/artifacts';
import { assetRoutes } from '@agentic-marketing/assets';
import { archiveRoutes, broadcastImpact, formsApi, withEmailProfileEvents, withResolvedEventProfiles } from '@agentic-marketing/audience';
import {
  type AuthConfig,
  acceptInvitation,
  authDirectory,
  createAuth,
  invitationWorkspace,
  isMcpResourceUrlAllowed,
} from '@agentic-marketing/auth';
import { createExecutor, type Services, userPrincipal } from '@agentic-marketing/commands';
import { AppError, newUuid, RESOLVED_CLIENT_IP_HEADER, remoteAddressFromEnv, resolveClientIp } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { emailRoutes, linkSigner, pushRoutes } from '@agentic-marketing/email';
import { clickHouseStore, lazyNatsBus } from '@agentic-marketing/events';
import { valkeyHotState } from '@agentic-marketing/hotstate';
import { ingestApi } from '@agentic-marketing/ingest';
import { egressFetch, egressHttp2, inboundApi, oauthRoutes, safeRequest } from '@agentic-marketing/integrations';
import { journeyImpact } from '@agentic-marketing/journeys';
import { decideApi, edgeMirror } from '@agentic-marketing/personalize';
import { refreshPeople } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { Hono } from 'hono';
import { mandateGuardrailBreach } from './agents/guardrails';
import type { Config } from './config';
import { copilotApi } from './http/copilot';
import { mcpEndpoint } from './http/mcp';
import { consentPage, invitePage, loginPage } from './http/pages';
import { rejectUnsafeRawPath } from './http/raw-path';
import { restApi } from './http/rest';
import { scimApi } from './http/scim';
import { securityHeaders } from './http/security-headers';
import { staticSite } from './http/static';
import { createInputWarningRecorder } from './inputWarnings';
import { keyProviderFor } from './keys';
import { COMMIT, VERSION } from './version';

/** `overrides` exist for tests, e.g. a stub transport for Client ID Metadata Documents. */
export function createServer(config: Config, overrides: Pick<AuthConfig, 'cimd'> = {}) {
  const db = createDb({ adminUrl: config.adminDatabaseUrl, appUrl: config.appDatabaseUrl });
  const mcpEnabled = isMcpResourceUrlAllowed(config.publicUrl);
  if (!mcpEnabled) {
    logger.warn(
      { publicUrl: config.publicUrl },
      'MCP/OAuth client endpoints are disabled because PUBLIC_URL is plain HTTP on a non-loopback host; the admin UI and REST API still work. Use HTTPS (e.g. Tailscale or a Cloudflare Tunnel) to enable MCP.',
    );
  }
  const auth = createAuth({
    baseUrl: config.publicUrl,
    secret: config.authSecret,
    db,
    trustedOrigins: config.trustedOrigins,
    clientIpHeaders: [RESOLVED_CLIENT_IP_HEADER],
    sso: config.sso,
    ...overrides,
  });
  const keyProvider = keyProviderFor(config);
  const directory = authDirectory(db);
  const bus = lazyNatsBus(config.nats);
  // E-mail delivery events also become customer events (segments, journeys, webhooks).
  const events = withEmailProfileEvents(withResolvedEventProfiles(clickHouseStore(config.clickhouse), db), { db, bus });
  // Snapshot writes also queue for the edge (Workers KV) where a workspace turned it on.
  const hot = edgeMirror(valkeyHotState(config.valkey), db);
  const inputWarnings = createInputWarningRecorder(db);
  const email = {
    publicUrl: config.linksUrl,
    links: linkSigner(config.authSecret),
    // Provider adapters reach the outside world through the egress guard too.
    adapterDeps: { fetch: egressFetch(config.egress), http2: egressHttp2(config.egress) },
    trackClicks: config.trackClicks,
    // Pre-send link checks use the same guard as webhooks: no redirects, private addresses refused
    // unless EGRESS_ALLOWED_HOSTS allows them, and a five second ceiling per link.
    checkLinks: async (url: string, method: 'HEAD' | 'GET') => ({
      status: (
        await safeRequest(
          url,
          { method, headers: method === 'GET' ? { range: 'bytes=0-0' } : {}, timeoutMs: 5000, maxBytes: 4096 },
          config.egress,
        )
      ).status,
    }),
  };
  const services: Services = {
    keyProvider,
    directory,
    events,
    bus,
    email,
    assets: { publicUrl: config.linksUrl, maxBytes: config.assetMaxBytes },
    hot,
    egress: config.egress,
    publicUrl: config.publicUrl,
    linksUrl: config.linksUrl,
    db,
    serverVersion: VERSION,
    strictInputs: config.strictInputs,
    // Reach of publishing, for the agent policy engine (ADR-0016).
    artifactImpact: {
      broadcast: (tx, id, version) => broadcastImpact(tx, id, version),
      journey: (tx, id) => journeyImpact(tx, id),
    },
    stepUpLimiter: {
      lockedUntil: (userId) => hot.failureLock(`stepup:${userId}`),
      recordFailure: (userId) =>
        hot.recordFailure(`stepup:${userId}`, config.stepUp.maxFailures, config.stepUp.windowSeconds, config.stepUp.lockoutSeconds),
      reset: (userId) => hot.clearFailures(`stepup:${userId}`),
    },
    // The agent's active mandate and its guardrails on its own sends (ADR-0016, #224).
    activeMandate: (tx, agentId) => activeMandate(tx, agentId),
    mandateGuardrails: (tx, workspaceId, agentId, mandate) => mandateGuardrailBreach({ tx, events, workspaceId }, agentId, mandate),
  };
  const executor = createExecutor(db, services, {
    strictInputs: config.strictInputs,
    onUnknownKeys: (command, unknown, principal) => {
      logger.warn({ command, unknownKeys: unknown.map((u) => u.path) }, 'command input has unknown keys');
      inputWarnings.record(command, unknown, principal);
    },
  });

  const app = new Hono();
  // Baseline security headers on every response; routes with their own policy keep it (#178).
  app.use('*', securityHeaders({ https: config.publicUrl.startsWith('https://') }));
  // Defence in depth for a proxy that forwards raw paths: never route a traversal target.
  app.use('*', rejectUnsafeRawPath);

  /**
   * Resolves the client IP once, then replaces any caller-supplied value of the resolved header.
   * Better Auth reads only that header, so admin sign-ins cannot share (or pick) a rate-limit
   * bucket through a spoofed forwarding header.
   */
  const withClientIp = (c: { req: { raw: Request }; env: unknown }) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(RESOLVED_CLIENT_IP_HEADER);
    const ip = resolveClientIp({
      header: (name) => headers.get(name) ?? undefined,
      remoteAddress: remoteAddressFromEnv(c.env),
      headerNames: config.clientIpHeaders,
      trustedProxyCidrs: config.trustedProxyCidrs,
    });
    if (ip) headers.set(RESOLVED_CLIENT_IP_HEADER, ip);
    return new Request(c.req.raw, { headers });
  };

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    const requestId = newUuid();
    logger.error({ err, requestId, path: c.req.path }, 'unhandled error');
    return c.json({ error: 'internal', message: 'Something went wrong on our side.', requestId }, 500);
  });

  // Operators and release checks read the running build here, not from a hard-coded literal.
  const build = COMMIT ? { version: VERSION, commit: COMMIT } : { version: VERSION };
  app.get('/healthz', (c) => c.json({ ok: true, ...build }));
  app.get('/readyz', async (c) => {
    try {
      await db.ping();
      if (!(await events.ping())) throw new Error('ClickHouse is not reachable');
      if (!(await hot.ping())) throw new Error('Valkey is not reachable');
      return c.json({ ok: true, ...build });
    } catch {
      return c.json({ ok: false, ...build }, 503);
    }
  });

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(withClientIp(c)));

  // OAuth discovery at the root, where MCP clients look (RFC 8414 path insertion included). The MCP
  // plugin answers RFC 9728 protected-resource metadata itself when the root path reaches it.
  const asMeta = oauthProviderAuthServerMetadata(auth);
  const oidcMeta = oauthProviderOpenIdConfigMetadata(auth);
  app.get('/.well-known/oauth-authorization-server', (c) => asMeta(c.req.raw));
  app.get('/.well-known/oauth-authorization-server/*', (c) => asMeta(c.req.raw));
  app.get('/.well-known/openid-configuration', (c) => oidcMeta(c.req.raw));
  app.get('/.well-known/openid-configuration/*', (c) => oidcMeta(c.req.raw));
  if (mcpEnabled) {
    app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(withClientIp(c)));
    app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(withClientIp(c)));
  }

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
  if (config.roles.has('ingest')) app.route('/', pushRoutes({ db, kp: keyProvider }));
  if (config.roles.has('ingest'))
    app.route('/', ingestApi({ db, bus, hot, clientIpHeaders: config.clientIpHeaders, trustedProxyCidrs: config.trustedProxyCidrs }));
  if (config.roles.has('api'))
    app.route(
      '/',
      emailRoutes({
        db,
        kp: keyProvider,
        events,
        email,
        consentChanged: async (ws, people, cause) => {
          const changes = await db.withWorkspace(ws, (tx) => refreshPeople(tx, ws, people, events, cause));
          if (changes.length) await bus.publish(changes);
        },
      }),
    );
  if (config.roles.has('ingest')) app.route('/', inboundApi({ db, bus, kp: keyProvider }));
  if (config.roles.has('api')) app.route('/', oauthRoutes({ db, kp: keyProvider, egress: config.egress }));
  // Public asset links, on both roles that front the public edge (like /f and /u).
  if (config.roles.has('api') || config.roles.has('ingest')) app.route('/', assetRoutes({ db }));
  // The public newsletter archive and signed web versions, on the same links host (#100).
  if (config.roles.has('api') || config.roles.has('ingest'))
    app.route('/', archiveRoutes({ db, kp: keyProvider, links: email.links, linksUrl: config.linksUrl }));
  if (config.roles.has('ingest'))
    app.route(
      '/',
      formsApi({
        db,
        bus,
        kp: keyProvider,
        links: email.links,
        egress: config.egress,
        clientIpHeaders: config.clientIpHeaders,
        trustedProxyCidrs: config.trustedProxyCidrs,
      }),
    );

  if (mcpEnabled) {
    const mcp = mcpEndpoint({
      auth,
      db,
      executor,
      resource: `${config.publicUrl}/mcp`,
      textContent: config.mcpTextContent,
      toolNameStyle: config.mcpToolNameStyle,
    });
    app.all('/mcp', (c) => mcp(c.req.raw));
  }
  if (config.roles.has('api')) app.route('/', copilotApi({ auth, db, executor, kp: keyProvider }));
  if (config.roles.has('api')) app.route('/', scimApi({ auth, db, executor, publicUrl: config.publicUrl }));
  app.route('/', restApi({ auth, db, executor, assetMaxBytes: config.assetMaxBytes }));

  // Last, so every API route above wins. Without a build (packages/tests, server-only install) the
  // middleware is a no-op and the server behaves exactly as before.
  if (existsSync(config.webDist)) {
    app.use('*', staticSite({ root: config.webDist }));
    logger.info({ webDist: config.webDist }, 'serving the admin UI at /');
  }

  return {
    app,
    db,
    auth,
    executor,
    keyProvider,
    directory,
    bus,
    events,
    email,
    hot,
    egress: config.egress,
    publicUrl: config.publicUrl,
    linksUrl: config.linksUrl,
    retention: config.retention,
    erasureGraceHours: config.erasureGraceHours,
    services,
  };
}
