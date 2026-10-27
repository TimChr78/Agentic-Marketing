import type { AddressInfo } from 'node:net';
import { migrateAuth } from '@agentic-marketing/auth';
import { type ApiError, createClient } from '@agentic-marketing/client';
import { newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { migrateClickHouse, resetClickHouse, resetNatsNamespace } from '@agentic-marketing/events';
import { serve } from '@hono/node-server';
import { Client, type OAuthClientProvider, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import pg from 'pg';
import { createServer } from '../src/app';
import { loadConfig } from '../src/config';
import { publicOnly } from '../src/http/public-only';
import type { Commands } from '../src/registry';
import { startScheduler, startWorkers } from '../src/workers';

// A complete server (Postgres, ClickHouse, NATS, api + ingest + worker roles) on fresh databases.

export type User = { email: string; cookie: string; id: string };
export const PASSWORD = 'correct-horse-battery-staple';

export const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

export const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to fail');
};

export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - started > ms) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export class TestOAuthProvider implements OAuthClientProvider {
  constructor(readonly clientMetadataUrl?: string) {}
  info: any;
  tokenSet: any;
  verifier = '';
  discovery: any;
  authorizationUrl?: URL;
  get redirectUrl() {
    return 'http://localhost/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'Phase 0 test agent',
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: unknown) {
    this.info = i;
  }
  tokens() {
    return this.tokenSet;
  }
  saveTokens(t: unknown) {
    this.tokenSet = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(s: unknown) {
    this.discovery = s;
  }
  discoveryState() {
    return this.discovery;
  }
}

export const grantFrom = (requested: string, permissions: string[]) =>
  requested
    .split(' ')
    .filter((s) => !s.includes(':') || permissions.includes(s))
    .join(' ');

/** Plays the person in the browser: authorize → sign in → consent with the chosen permissions. */
export async function connectAgent(BASE: string, u: User, permissions: string[], clientMetadataUrl?: string) {
  const provider = new TestOAuthProvider(clientMetadataUrl);
  const first = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider });
  const unauthorized = await new Client({ name: 't', version: '0' }).connect(first).then(
    () => null,
    (e) => e,
  );
  if (!(unauthorized instanceof UnauthorizedError)) throw new Error('expected the first MCP connection to need authorization');

  const authz = await fetch(provider.authorizationUrl!, { redirect: 'manual', headers: { accept: 'application/json' } });
  const login = new URL(authz.headers.get('location') ?? (await authz.json()).url, BASE);
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: u.email, password: PASSWORD, oauth_query: login.search.slice(1) }),
  });
  let next = new URL((await signIn.json()).url, BASE);
  if (next.pathname === '/consent') {
    const consent = await fetch(`${BASE}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: cookieOf(signIn) },
      // Like the consent page: identity scopes as requested, permissions as chosen (never more than requested).
      body: JSON.stringify({
        accept: true,
        scope: grantFrom(next.searchParams.get('scope') ?? '', permissions),
        oauth_query: next.search.slice(1),
      }),
    });
    const body = await consent.json();
    if (!body.url) throw new Error(`consent failed: ${JSON.stringify(body)}`);
    next = new URL(body.url);
  }
  await first.finishAuth(next.searchParams);
  const client = new Client({ name: 'phase0-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider }));
  return { client, clientId: provider.info.client_id as string, provider };
}

export async function startTestServer(name: string, port: number, env: Record<string, string> = {}) {
  const base = `http://localhost:${port}`;
  const pgUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  const dbName = `am_${name}`;
  pgUrl.pathname = `/${dbName}`;
  const maint = new pg.Client({ connectionString: Object.assign(new URL(pgUrl), { pathname: '/postgres' }).toString() });
  await maint.connect();
  await maint.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await maint.query(`CREATE DATABASE ${dbName}`);
  await maint.end();

  const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
  await resetNatsNamespace(natsUrl, dbName);

  const config = loadConfig({
    PORT: String(port),
    DATABASE_URL: pgUrl.toString(),
    APP_DB_ROLE: 'am_app_test',
    APP_DB_PASSWORD: 'am_app_test_password',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    CLICKHOUSE_DATABASE: dbName,
    CLICKHOUSE_ROW_POLICIES: process.env.CLICKHOUSE_ROW_POLICIES ?? 'auto',
    NATS_URL: natsUrl,
    NATS_NAMESPACE: dbName,
    VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
    VALKEY_PREFIX: dbName,
    // Test receivers for webhooks and connector actions listen on loopback.
    EGRESS_ALLOWED_HOSTS: '127.0.0.1',
    ...env,
  });
  const srv = createServer(config);
  await resetClickHouse(config.clickhouse.url, dbName);
  await migrate(srv.db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole });
  await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: srv.db });
  await migrateClickHouse(config.clickhouse.url, config.clickhouse.database, undefined, config.clickhouse);
  let http: { close: () => void } | undefined;
  await new Promise<void>((resolve) => {
    http = serve({ fetch: srv.app.fetch, port }, (_i: AddressInfo) => resolve());
  });
  let publicHttp: { close: () => void } | undefined;
  if (config.publicPort) {
    await new Promise<void>((resolve) => {
      publicHttp = serve({ fetch: publicOnly(srv.app).fetch, port: config.publicPort! }, (_i: AddressInfo) => resolve());
    });
  }
  const stop = new AbortController();
  const workers = [
    ...startWorkers(srv, stop.signal, { deliveries: { webhookBackoffMs: [200, 200], actionBackoffMs: [100] } }),
    ...startScheduler(srv, stop.signal, {
      segmentTickMs: 500,
      broadcastTickMs: 300,
      warehouseTickMs: 300,
      warehouseLagMs: 0,
      edgeTickMs: 200,
      // Alert tests drive the evaluator directly with a fixed clock; keep the background loop out of the way.
      alertTickMs: 86_400_000,
    }),
  ];

  async function signUp(email: string): Promise<User> {
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, password: PASSWORD, name: email.split('@')[0] }),
    });
    if (res.status !== 200) throw new Error(`sign-up failed: ${await res.text()}`);
    return { email, cookie: cookieOf(res), id: (await res.json()).user.id };
  }

  async function workspaceWith(members: [User, string][], policy = 'none') {
    const id = newUuid();
    await srv.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [id, `ws ${id.slice(-4)}`, policy]);
    for (const [u, role] of members)
      await srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [id, u.id, role]);
    return id;
  }

  return {
    srv,
    base,
    publicBase: config.publicPort ? `http://localhost:${config.publicPort}` : undefined,
    signUp,
    workspaceWith,
    api: (u: User, workspaceId?: string) =>
      createClient<Commands>({ baseUrl: base, headers: { cookie: u.cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) } }),
    async close() {
      stop.abort();
      publicHttp?.close();
      http?.close();
      await Promise.allSettled(workers);
      await srv.bus.close();
      await srv.events.close();
      await srv.hot.close();
      await srv.db.close();
    },
  };
}
