import type { AddressInfo } from 'node:net';
import { migrateAuth } from '@agentic-marketing/auth';
import { type ApiError, createClient } from '@agentic-marketing/client';
import { newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { migrateClickHouse, resetClickHouse, resetNatsNamespace } from '@agentic-marketing/events';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { Commands } from '../src/registry';
import { startWorkers } from '../src/workers';

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

export async function startTestServer(name: string, port: number) {
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
    APP_DB_PASSWORD: 'am_app_test_password',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    CLICKHOUSE_DATABASE: dbName,
    NATS_URL: natsUrl,
    NATS_NAMESPACE: dbName,
  });
  const srv = createServer(config);
  await resetClickHouse(config.clickhouse.url, dbName);
  await migrate(srv.db.admin, { appRolePassword: config.appDbPassword });
  await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: srv.db });
  await migrateClickHouse(config.clickhouse.url, config.clickhouse.database);
  let http: { close: () => void } | undefined;
  await new Promise<void>((resolve) => {
    http = serve({ fetch: srv.app.fetch, port }, (_i: AddressInfo) => resolve());
  });
  const stop = new AbortController();
  const workers = startWorkers(srv, stop.signal);

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
    signUp,
    workspaceWith,
    api: (u: User, workspaceId?: string) =>
      createClient<Commands>({ baseUrl: base, headers: { cookie: u.cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) } }),
    async close() {
      stop.abort();
      http?.close();
      await Promise.allSettled(workers);
      await srv.bus.close();
      await srv.events.close();
      await srv.db.close();
    },
  };
}
