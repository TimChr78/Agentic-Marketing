import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { migrateAuth } from '@agentic-marketing/auth';
import { type ApiError, createClient } from '@agentic-marketing/client';
import { newUuid } from '@agentic-marketing/core';
import { createDb, migrate } from '@agentic-marketing/db';
import { consumerPhases, migrateClickHouse, resetClickHouse, resetNatsNamespace, resetNatsPrefix } from '@agentic-marketing/events';
import { serve } from '@hono/node-server';
import { Client, type OAuthClientProvider, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import pg from 'pg';
import { runDatabaseMarker, runId, scopedDbName, testPortOffset } from '../../../packages/db/test/run';
import { createServer } from '../src/app';
import { loadConfig } from '../src/config';
import { prefixOf } from '../src/domains';
import { publicOnly } from '../src/http/public-only';
import type { Commands } from '../src/registry';
import { startScheduler, startWorkers, type WorkerLoop } from '../src/workers';
import {
  ensureTemplateDatabase,
  quoteIdent,
  sweepRunDatabases,
  templateDatabaseName,
  templateFingerprint,
  templateMarker,
  withTemplateLock,
} from './template-db';

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

/**
 * One step of closing a test server. `inspect` runs only when the step exceeded the budget, and
 * says what it is still waiting for; it is capped itself, so a diagnostic cannot hang the hook.
 */
export interface CloseStage {
  name: string;
  close: () => void | Promise<void>;
  inspect?: () => string | Promise<string>;
}

/**
 * How long a test server's close may take in total before it reports what is still open (#1028).
 * Measured: a healthy close is under a second idle; the heaviest file (`v0145-campaign-identity`,
 * which leaves bus events for all 16 profile shards) took 4.6-7.4 s with the machine saturated,
 * because a worker finishes its in-flight batch and those batches serialize on the workspace
 * identity lock. 40 s stays under vitest's 60 s hook timeout with room for the diagnostics.
 */
const CLOSE_BUDGET_MS = Math.max(1_000, Number(process.env.AM_TEST_CLOSE_MS ?? 40_000));

/** How long one close step may take, so a step that hangs leaves the later ones a turn. */
const CLOSE_STAGE_MS = Math.max(100, Number(process.env.AM_TEST_CLOSE_STAGE_MS ?? 20_000));

type SettleOutcome = 'done' | 'failed' | 'timeout';

/** Whether `work` settled within `ms`, without waiting for it when it does not. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<SettleOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SettleOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const settled = work.then<SettleOutcome, SettleOutcome>(
    () => 'done',
    () => 'failed',
  );
  const outcome = await Promise.race([settled, deadline]);
  if (timer) clearTimeout(timer);
  return outcome;
}

/** The stage's own account of what is still open, capped so the report itself cannot hang. */
async function diagnose(stage: CloseStage): Promise<string> {
  if (!stage.inspect) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const detail = await Promise.race([
      Promise.resolve().then(stage.inspect),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('inspection timed out'), 2_000);
      }),
    ]);
    return detail ? ` (${detail})` : '';
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One line per close step in `AM_TEST_CLOSE_TRACE`, so the bounds can be chosen from timings. */
function traceSettle(worker: WorkerLoop, ms: number): void {
  const file = process.env.AM_TEST_CLOSE_TRACE;
  if (file) appendFileSync(file, `worker\t${worker.worker}\t${ms}\n`);
}

/** The handle kinds the process still holds, so a report names a socket, timer or file. */
function openHandles(): string {
  const info = process.getActiveResourcesInfo?.() ?? [];
  const counts = new Map<string, number>();
  for (const kind of info) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${kind}${n > 1 ? ` ×${n}` : ''}`).join(', ') || 'none';
}

/**
 * Runs teardown steps in order within one budget (#1028). A step that exceeds its cap is reported,
 * never waited for: a file whose tests passed must not spend the hook timeout on a resource that
 * will not close, and the report says which resource it was. The steps after it still run, so one
 * stuck pool does not leave the others open too. A step that throws is named and the rest still
 * run. Throws one error naming every problem, failing the file fast and clearly.
 */
export async function closeBounded(
  stages: readonly CloseStage[],
  limits: { budgetMs: number; stageMs?: number; now?: () => number },
): Promise<void> {
  const stageMs = limits.stageMs ?? limits.budgetMs;
  // The budget is measured on this clock. Wall time leaves a step that times out at exactly the
  // budget reported as either "spent" or not, one millisecond either way (#1041); a test that spends
  // the budget deterministically passes its own clock.
  const now = limits.now ?? Date.now;
  const started = now();
  const open: string[] = [];
  const failed: string[] = [];
  for (const stage of stages) {
    const left = limits.budgetMs - (now() - started);
    if (left <= 0) {
      open.push(`${stage.name}${await diagnose(stage)} (did not start: the budget was spent)`);
      continue;
    }
    const stageStarted = Date.now();
    const outcome = await settleWithin(
      Promise.resolve().then(() => stage.close()),
      Math.min(left, stageMs),
    );
    // AM_TEST_CLOSE_TRACE=<file> appends one line per step, so the bounds can be chosen from timings.
    if (process.env.AM_TEST_CLOSE_TRACE)
      appendFileSync(process.env.AM_TEST_CLOSE_TRACE, `${stage.name}\t${outcome}\t${Date.now() - stageStarted}\n`);
    if (outcome === 'timeout') open.push(`${stage.name} (no close after ${Date.now() - stageStarted}ms${await diagnose(stage)})`);
    else if (outcome === 'failed') failed.push(stage.name);
  }
  if (!open.length && !failed.length) return;
  const problems = [
    ...(open.length ? [`still open: ${open.join(', ')}`] : []),
    ...(failed.length ? [`failed to close: ${failed.join(', ')}`] : []),
  ];
  throw new Error(`the test server did not close cleanly (#1028): ${problems.join('; ')}. Open handles: ${openHandles()}`);
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
export async function connectAgent(BASE: string, u: User, permissions: string[], clientMetadataUrl?: string, workspaceId?: string) {
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
    // Like the consent page, choose the brand before accepting when the person belongs to several.
    if (workspaceId) {
      const chosen = await fetch(`${BASE}/api/oauth/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, cookie: cookieOf(signIn) },
        body: JSON.stringify({
          workspaceId,
          scope: grantFrom(next.searchParams.get('scope') ?? '', permissions),
          oauthQuery: next.search.slice(1),
        }),
      });
      if (!chosen.ok) throw new Error(`workspace choice failed: ${await chosen.text()}`);
    }
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

/**
 * A test file's port, moved into its worker's own block: test files run in parallel workers, and
 * the numbers in the files repeat. Worker n adds (n - 1) * 5 000.
 *
 * The stride must be larger than the spread of the base numbers (currently 2 500–4 700). It used to
 * be 1 000, so bases that differed by 1 000 landed on the same port in neighbouring workers:
 * experience-rollout (3 600) and password-reset (2 600 + 1 000) both listened on 3 600 in CI, and
 * one failed with EADDRINUSE inside its beforeAll hook (#990 follow-up). Files in one worker run
 * one at a time, so a repeated base there is safe. TEST_PORT_OFFSET still moves every block, so two
 * checkouts can run at once.
 */
export const testPort = (port: number) => port + (Number(process.env.VITEST_POOL_ID ?? '1') - 1) * 5_000 + testPortOffset();

/**
 * The migrated template database: named after a fingerprint of the whole build recipe, so an
 * unchanged tree reuses it across runs and checkouts, and test-setup.ts shares the name through
 * AM_TEST_TEMPLATE.
 */
export const templateDbName = () => process.env.AM_TEST_TEMPLATE ?? templateDatabaseName(templateFingerprint({ role: APP_ROLE }));

// Hot state (rate-limit buckets, sessions, snapshots) is not dropped with the databases. A run-unique
// prefix keeps one run's buckets out of the next one, which matters now that seeded fixtures reuse
// the same client IPs and message ids on every run.
const VALKEY_RUN_ID = `${process.pid.toString(36)}_${Date.now().toString(36)}`;
export const APP_ROLE = { appRole: 'am_app_test', appRolePassword: 'am_app_test_password' };

/** The admin URL of a test database on the TEST_DATABASE_URL server. */
export function testDatabaseUrl(dbName: string) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test');
  url.pathname = `/${dbName}`;
  return url;
}

/**
 * Builds the template: Postgres migrations, the app role and better-auth's tables, under the shared
 * maintenance advisory lock (test-setup.ts). The template is keyed on a fingerprint of the whole
 * recipe (migrations, migrator, auth options, Better Auth version, app role), so a run reuses a
 * completed one when nothing changed instead of replaying every migration, and the lock keeps two
 * concurrent runs from building or dropping it at once. The same lock and pass sweep run databases
 * that killed runs left behind, on the shared test stack only. Templates are never pruned here; see
 * `pnpm test:clean -- --templates`. Returns the name.
 */
export async function prepareTemplateDatabase(): Promise<string> {
  const fingerprint = templateFingerprint({ role: APP_ROLE });
  const template = templateDatabaseName(fingerprint);
  const marker = templateMarker(fingerprint);
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  try {
    await withTemplateLock(maint, async () => {
      const swept = await sweepRunDatabases(maint, { run: runId });
      if (!swept.swept) console.log(`[test] run-database sweep skipped: ${swept.reason}`);
      else if (swept.found) console.log(`[test] swept ${swept.found} run database(s): dropped ${swept.dropped.length} older than 6 hours`);
      const { built } = await ensureTemplateDatabase(maint, {
        name: template,
        marker,
        build: async (name) => {
          const db = createDb({ adminUrl: testDatabaseUrl(name).toString(), appUrl: testDatabaseUrl(name).toString() });
          try {
            await migrate(db.admin, APP_ROLE);
            await migrateAuth({ baseUrl: 'http://localhost', secret: 'test-secret-test-secret-test-secret-123', db });
          } finally {
            await db.close();
          }
        },
      });
      console.log(`[test] ${built ? 'built' : 'reused'} template ${template}`);
    });
  } finally {
    await maint.end();
  }
  return template;
}

/**
 * Drops everything this run created, by its own prefix only. test-setup.ts runs it in global
 * teardown; `AM_TEST_KEEP_DB=1` keeps the databases of a failed run for inspection. CI has no run
 * namespace, so it keeps the old behaviour and the runner disposes of its service containers.
 */
export async function dropRunDatabases() {
  if (!runId || process.env.AM_TEST_KEEP_DB) return;
  const prefix = `am_${runId}_`;
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  let pgNames: string[] = [];
  try {
    const { rows } = await maint.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate AND starts_with(datname, $1)',
      [prefix],
    );
    pgNames = rows.map((r) => r.datname);
    for (const name of pgNames) await maint.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maint.end();
  }

  const chUrl = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  const chNames = (await (await fetch(`${chUrl}/?query=${encodeURIComponent('SHOW DATABASES')}`)).text())
    .split('\n')
    .filter((name) => name.startsWith(prefix));
  for (const name of chNames) await resetClickHouse(chUrl, name);

  const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
  if (runId) {
    // Package tests create streams like am_<run>_test_events_pkg that no database name reveals.
    await resetNatsPrefix(natsUrl, prefix).catch(() => {});
  } else {
    for (const name of new Set([...pgNames, ...chNames])) await resetNatsNamespace(natsUrl, name).catch(() => {});
  }
}

/**
 * Drops and creates a test database: a copy of the migrated template when test-setup.ts made one,
 * else empty (the e2e server, a single file run outside the server project). `migrated` says which.
 * The name is run-scoped, so two checkouts on one stack never drop each other's databases.
 */
export async function freshDatabase(name: string): Promise<{ url: URL; migrated: boolean; dbName: string }> {
  const dbName = scopedDbName(name);
  const template = process.env.AM_TEST_TEMPLATE;
  const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    for (let attempt = 0; ; attempt++) {
      try {
        await maint.query(template ? `CREATE DATABASE ${dbName} TEMPLATE ${template}` : `CREATE DATABASE ${dbName}`);
        break;
      } catch (e) {
        // Two copies of the template starting at the same moment: Postgres refuses the second.
        if (!template || attempt >= 20 || !/being accessed by other users/.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      }
    }
    // Ownership metadata for the sweeper: only a database carrying this comment is a run database,
    // so a name alone (am_customer_archive) or a database from before this marker is never dropped.
    const marker = runDatabaseMarker(runId).replaceAll("'", "''");
    await maint.query(`COMMENT ON DATABASE ${quoteIdent(dbName)} IS '${marker}'`);
  } finally {
    await maint.end();
  }
  return { url: testDatabaseUrl(dbName), migrated: Boolean(template), dbName };
}

export async function startTestServer(
  name: string,
  port: number,
  env: Record<string, string> = {},
  testOptions: {
    warehouseTickMs?: number;
    edgeTickMs?: number;
    holdTickMs?: number;
    erasureFinalSweepMs?: number;
    erasureCleanup?: boolean;
  } = {},
) {
  const base = `http://localhost:${port}`;
  const { url: pgUrl, migrated, dbName } = await freshDatabase(`am_${name}`);

  const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
  await resetNatsNamespace(natsUrl, dbName);

  const config = loadConfig({
    PORT: String(port),
    DATABASE_URL: pgUrl.toString(),
    APP_DB_ROLE: APP_ROLE.appRole,
    APP_DB_PASSWORD: APP_ROLE.appRolePassword,
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    CLICKHOUSE_DATABASE: dbName,
    CLICKHOUSE_ROW_POLICIES: process.env.CLICKHOUSE_ROW_POLICIES ?? 'auto',
    NATS_URL: natsUrl,
    NATS_NAMESPACE: dbName,
    VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
    VALKEY_PREFIX: `${dbName}_${VALKEY_RUN_ID}`,
    // Test receivers for webhooks and connector actions listen on loopback.
    EGRESS_ALLOWED_HOSTS: '127.0.0.1',
    ...env,
  });
  const srv = createServer(config);
  await resetClickHouse(config.clickhouse.url, dbName);
  if (!migrated) {
    await migrate(srv.db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole });
    await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: srv.db });
  }
  await migrateClickHouse(config.clickhouse.url, config.clickhouse.database, undefined, config.clickhouse);
  let http: { close: () => void } | undefined;
  await new Promise<void>((resolve) => {
    http = serve({ fetch: srv.app.fetch, port }, (_i: AddressInfo) => resolve());
  });
  let publicHttp: { close: () => void } | undefined;
  if (config.publicPort) {
    await new Promise<void>((resolve) => {
      publicHttp = serve({ fetch: publicOnly(srv.app, prefixOf(srv.domains)).fetch, port: config.publicPort! }, (_i: AddressInfo) =>
        resolve(),
      );
    });
  }
  const stop = new AbortController();
  const workers: WorkerLoop[] = [
    ...startWorkers(srv, stop.signal, {
      deliveries: { webhookBackoffMs: [200, 200], actionBackoffMs: [100] },
      // Password-reset tests drive delivery rounds directly, so the background loop cannot race them.
      passwordResetTickMs: 86_400_000,
    }),
    ...startScheduler(srv, stop.signal, {
      segmentTickMs: 500,
      broadcastTickMs: 300,
      warehouseTickMs: testOptions.warehouseTickMs ?? 300,
      warehouseLagMs: 0,
      edgeTickMs: testOptions.edgeTickMs ?? 200,
      // Alert tests drive the evaluator directly with a fixed clock; keep the background loop out of the way.
      alertTickMs: 86_400_000,
      // Agent notification tests drive the job directly with a fixed clock; keep the loop away.
      agentNotifyTickMs: 86_400_000,
      // Agent event tests drive the sweep directly with a fixed clock.
      agentEventTickMs: 86_400_000,
      // Hosted agent tests drive the sweep directly with a fixed clock too.
      hostedAgentTickMs: 86_400_000,
      // Content source tests fetch on demand and drive the sweep with a fixed clock.
      contentTickMs: 86_400_000,
      // Idempotency retention is driven by its own test; keep the periodic loop out of the way.
      idempotencyCleanupTickMs: 86_400_000,
      // Bulk enrollment tests drive the job directly with runEnrollmentJobsOnce.
      enrollmentTickMs: 86_400_000,
      guardianTickMs: 86_400_000,
      // A test that drives held changes itself keeps the background loop away (#907).
      holdTickMs: testOptions.holdTickMs ?? 300,
      // Experience rollout tests drive the sweep directly with a fixed clock.
      rolloutTickMs: 86_400_000,
      // Erasure tests drive the cleanup rounds themselves. The short default final-sweep bound
      // keeps the suite fast; production waits the ClickHouse request timeout plus a margin.
      erasureFinalSweepMs: testOptions.erasureFinalSweepMs ?? 1_000,
      ...(testOptions.erasureCleanup === undefined ? {} : { erasureCleanup: testOptions.erasureCleanup }),
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
    dbName,
    publicBase: config.publicPort ? `http://localhost:${config.publicPort}` : undefined,
    signUp,
    workspaceWith,
    api: (u: User, workspaceId?: string) =>
      createClient<Commands>({
        baseUrl: base,
        // A browser sends Origin on every cookie-authenticated POST; the REST surface now requires it.
        headers: { cookie: u.cookie, origin: base, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
      }),
    async close() {
      stop.abort();
      // A keep-alive socket keeps the listener's handles open for its idle timeout: destroy them
      // instead of draining, so nothing outlives the file (#1028).
      for (const server of [publicHttp, http] as ({ close: () => void; closeAllConnections?: () => void } | undefined)[]) {
        server?.closeAllConnections?.();
        server?.close();
      }
      const workersDone = Promise.allSettled(workers);
      const running = new Set<Promise<unknown>>(workers);
      const closeStarted = Date.now();
      for (const w of workers)
        void w.then(
          () => {
            running.delete(w);
            traceSettle(w, Date.now() - closeStarted);
          },
          () => {
            running.delete(w);
            traceSettle(w, Date.now() - closeStarted);
          },
        );
      const workerReport = () => {
        if (!running.size) return '';
        // Consumers know their own phase; a scheduler loop only has a name.
        const where = new Map(consumerPhases().map((p) => [p.name, `${p.phase} ${(p.forMs / 1000).toFixed(1)}s`]));
        const names = workers
          .filter((w) => running.has(w))
          .map((w) => (where.has(w.worker) ? `${w.worker} (${where.get(w.worker)})` : w.worker));
        return `${names.length} still running: ${names.join(', ')}`;
      };
      // Bounded, in order, and reported: a worker loop, the bus, ClickHouse, Valkey or a pool that
      // will not close names itself instead of consuming the hook timeout silently (#1028).
      await closeBounded(
        [
          {
            name: 'workers',
            close: async () => {
              await workersDone;
            },
            inspect: workerReport,
          },
          { name: 'nats', close: () => srv.bus.close() },
          { name: 'clickhouse', close: () => srv.events.close() },
          { name: 'valkey', close: () => srv.hot.close() },
          { name: 'postgres', close: () => srv.db.close(), inspect: () => databaseReport(pgUrl, srv.db) },
        ],
        { budgetMs: CLOSE_BUDGET_MS, stageMs: CLOSE_STAGE_MS },
      );
    },
  };
}

/**
 * What a stuck database pool is waiting for: how many clients each pool holds, and which of its
 * backends are not idle, what each waits on, for how long and under which application name. Never
 * the statement itself: its first characters can carry a password, a token or personal data, and
 * this report lands in a teardown failure and the CI log (#1028 review). Read on its own connection,
 * which is not one of the pools, with short timeouts so the report cannot hang the close it explains.
 */
export async function databaseReport(pgUrl: URL, db: { admin: pg.Pool; app: pg.Pool }): Promise<string> {
  const busy = (pool: pg.Pool) => `${pool.totalCount - pool.idleCount}/${pool.totalCount}`;
  const pools = `admin ${busy(db.admin)} busy, app ${busy(db.app)} busy, ${db.admin.waitingCount + db.app.waitingCount} waiting`;
  const client = new pg.Client({
    connectionString: pgUrl.toString(),
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
    query_timeout: 2_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ state: string; wait: string; seconds: number; application: string }>(
      `SELECT state,
              coalesce(wait_event_type || ':' || wait_event, '') AS wait,
              round(extract(epoch FROM now() - state_change))::int AS seconds,
              coalesce(application_name, '') AS application
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
       ORDER BY state_change
       LIMIT 5`,
    );
    const backends = rows
      .map((r) => `${r.state}${r.wait ? ` ${r.wait}` : ''} for ${r.seconds}s${r.application ? ` (${r.application})` : ''}`)
      .join('; ');
    return backends ? `${pools}; ${backends}` : pools;
  } catch {
    return pools;
  } finally {
    await client.end().catch(() => {});
  }
}
