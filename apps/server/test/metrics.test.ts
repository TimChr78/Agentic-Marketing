import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metricsHandler } from '../src/http/metrics';
import { createMetricsRegistry, routeGroup, statusClass } from '../src/metrics';
import { operationalHealthChecks } from '../src/ops/checks';
import { startTestServer, testPort, type User } from './harness';

// `GET /metrics` (#147): off unless METRICS_TOKEN is set, bearer-protected, on the main listener
// only, and labelled with bounded values (no workspace, person or address).

const PORT = testPort(3485);
const PUBLIC_PORT = testPort(3486);
const TOKEN = 'metrics-token-0123456789abcdef';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId: string;

const scrape = (bearer?: string) =>
  fetch(`${t.base}/metrics`, { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } });

beforeAll(async () => {
  t = await startTestServer('test_metrics', PORT, { METRICS_TOKEN: TOKEN, PUBLIC_PORT: String(PUBLIC_PORT) });
  owner = await t.signUp(`metrics-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

describe('metrics endpoint auth', () => {
  it('answers 404 when METRICS_TOKEN is not configured, so an unconfigured install advertises nothing', async () => {
    const app = new Hono();
    app.get(
      '/metrics',
      metricsHandler({
        registry: createMetricsRegistry(),
        db: t.srv.db,
        events: t.srv.events,
        hot: t.srv.hot,
        natsUrl: 'nats://127.0.0.1:1',
      }),
    );
    const res = await app.request('/metrics', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('needs the bearer token: missing and wrong tokens are 401', async () => {
    const missing = await scrape();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');

    const wrong = await scrape('metrics-token-ffffffffffff');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain('am_process_uptime_seconds');
  });

  it('serves the exposition with the right token', async () => {
    const res = await scrape(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    expect(await res.text()).toBeTruthy();
  });
});

describe('metrics exposition', () => {
  it('contains the expected metric names after requests and a command', async () => {
    // A few HTTP requests in known route groups, a client error, and one command through the executor.
    await fetch(`${t.base}/healthz`);
    await fetch(`${t.base}/healthz`);
    await fetch(`${t.base}/v1/nope`);
    await t.api(owner, workspaceId).call('system.status', {});

    const res = await scrape(TOKEN);
    expect(res.status).toBe(200);
    const body = await res.text();

    for (const name of [
      'am_process_uptime_seconds',
      'am_process_resident_memory_bytes',
      'am_process_heap_used_bytes',
      'am_process_event_loop_lag_seconds',
      'am_http_requests_total',
      'am_http_request_duration_seconds',
      'am_commands_total',
      'am_queue_messages_pending',
      'am_queue_messages_oldest_seconds',
      'am_journey_participants_due',
      'am_journey_participants_oldest_due_seconds',
      'am_broadcast_runs_due',
      'am_warehouse_exports_due',
      'am_deliveries_dead_24h',
      'am_agent_decisions_last_hour',
      'am_dependency_up',
    ])
      expect(body, name).toContain(`# TYPE ${name} `);

    // The route group and status class labels are counted, at least once with a 2xx.
    expect(body).toContain('am_http_request_duration_seconds_bucket{route="healthz",status="2xx",le="+Inf"}');
    expect(body).toMatch(/am_http_request_duration_seconds_count\{route="healthz",status="2xx"\} [1-9]/);
    expect(body).toMatch(/am_http_requests_total\{route="healthz",status="2xx"\} [1-9]/);
    expect(body).toMatch(/am_http_requests_total\{route="v1",status="4xx"\} [1-9]/);
    // The command ran through the executor's callback, not through a hard dependency.
    expect(body).toContain('am_commands_total{command="system.status",effect="read",outcome="ok"} 1');
    // Every dependency answered the same checks `/readyz` makes, plus the NATS TCP probe.
    for (const name of ['postgres', 'clickhouse', 'nats', 'valkey'])
      expect(body, name).toMatch(new RegExp(`am_dependency_up\\{name="${name}"\\} 1`));
    // All policy decisions are present so a dashboard shows zero instead of a gap.
    for (const decision of ['allow', 'hold', 'ask', 'deny'])
      expect(body, decision).toContain(`am_agent_decisions_last_hour{decision="${decision}"}`);
  });

  it('labels are bounded values and carry no workspace id', async () => {
    const body = await (await scrape(TOKEN)).text();
    expect(body).not.toContain(workspaceId);
    expect(body).not.toContain(owner.email);
    const groups = new Set(['auth', 'v1', 'mcp', 'pages', 'public', 'ui', 'api', 'well-known', 'healthz', 'readyz']);
    for (const match of body.matchAll(/route="([^"]*)"/g)) expect(groups.has(match[1]), match[1]).toBe(true);
    for (const match of body.matchAll(/status="([^"]*)"/g)) expect(match[1]).toMatch(/^[1-5]xx$/);
  });

  it('is not served on the public listener, even with the right token', async () => {
    expect(t.publicBase).toBeTruthy();
    const res = await fetch(`${t.publicBase}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('am_process_uptime_seconds');
  });
});

describe('metric helpers', () => {
  it('groups routes into a fixed set', () => {
    expect(routeGroup('/v1/artifacts.list')).toBe('v1');
    expect(routeGroup('/api/auth/sign-in/email')).toBe('auth');
    expect(routeGroup('/mcp')).toBe('mcp');
    expect(routeGroup('/f/newsletter')).toBe('public');
    expect(routeGroup('/hooks/inbound/abc')).toBe('public');
    expect(routeGroup('/assets/index-abc.js')).toBe('ui');
    expect(routeGroup('/readyz')).toBe('readyz');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(418)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });
});

describe('am doctor operational checks', () => {
  it('warns about a delivery queue that is not draining and about dead letters', async () => {
    const before = new Map((await operationalHealthChecks(t.srv.db)).map((check) => [check.id, check]));
    expect(before.get('queue.messages')?.status).toBe('ok');
    expect(before.get('deliveries')?.status).toBe('ok');

    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, purpose, status, created_at, updated_at)
       VALUES ($1, 'stuck-1', 'stuck-key-1', 'marketing', 'queued', now() - interval '30 minutes', now())`,
      [workspaceId],
    );
    await t.srv.db.admin.query(
      `INSERT INTO deliveries (workspace_id, id, kind, target_id, payload, status, idempotency_key, finished_at)
       VALUES ($1, 'dead-1', 'webhook', 'endpoint-1', '{}'::jsonb, 'dead', 'delivery-key-1', now())`,
      [workspaceId],
    );

    const after = new Map((await operationalHealthChecks(t.srv.db)).map((check) => [check.id, check]));
    expect(after.get('queue.messages')?.status).toBe('warn');
    expect(after.get('queue.messages')?.message).toContain('30 min');
    expect(after.get('deliveries')?.status).toBe('warn');
    expect(after.get('deliveries')?.message).toContain('1 webhook/action delivery');
  });
});
