import { connect } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Db } from '@agentic-marketing/db';

// A small Prometheus exposition (text format 0.0.4) built by hand: the server needs a handful of
// counters, one histogram and a few gauges, which is less code than a dependency and keeps the
// image and the lockfile unchanged (#147). Labels are bounded on purpose: route groups, fixed
// status classes, command names from the registry and the four policy decisions. No workspace id,
// address or person ever appears in a label.

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const DECISIONS = ['allow', 'hold', 'ask', 'deny'] as const;
/** A scrape must never hang on a slow database: each collector gives up after this. */
const COLLECT_TIMEOUT_MS = 3000;

export type CommandEvent = { command: string; effect: string; outcome: 'ok' | 'error'; durationMs: number };

export type DependencyName = 'postgres' | 'clickhouse' | 'nats' | 'valkey';

/** The values only a live install can answer, collected on each scrape (never cached). */
export interface GaugeSnapshot {
  /** Pending e-mail/message sends (`messages` in queued or sending). */
  messagesPending?: number;
  /** Age in seconds of the oldest pending message, i.e. how far the delivery queue is behind. */
  messagesOldestSeconds?: number;
  /** Journey participants whose next step is due (ready or waiting, due_at <= now). */
  journeyDue?: number;
  /** Age in seconds of the oldest due journey participant. */
  journeyOldestDueSeconds?: number;
  /** Broadcast runs past their send time that the scheduler has not picked up. */
  broadcastDue?: number;
  /** Enabled warehouse exports that are due or were asked to run. */
  warehouseDue?: number;
  /** Webhook/action deliveries that ended dead in the last 24 hours. */
  deliveriesDead24h?: number;
  /** Agent decisions in the ledger over the last hour, per decision. */
  agentDecisions?: { decision: string; count: number }[];
  dependencies?: { name: DependencyName; up: boolean }[];
}

/** Which route group a request belongs to. A fixed set, so the label cardinality cannot grow. */
export function routeGroup(path: string): string {
  if (path === '/healthz' || path === '/readyz' || path === '/metrics') return path.slice(1);
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/v1/')) return 'v1';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path === '/login' || path === '/consent' || path === '/invite') return 'pages';
  if (path.startsWith('/.well-known/')) return 'well-known';
  if (path.startsWith('/api/')) return 'api';
  const root = path.split('/')[1] ?? '';
  // The public edge: forms, unsubscribe/preference links, hosted pages, assets, inbound hooks.
  if (['f', 'u', 'c', 'a', 'n', 'hooks'].includes(root)) return 'public';
  // The admin UI's static files and its client-side routes.
  return 'ui';
}

/** HTTP status class label (`2xx`, `4xx`, …): bounded, unlike the exact status. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** Prometheus label values escape backslash, double quote and newline. */
function label(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const seriesKey = (...parts: string[]) => parts.join('\u0000');

export interface MetricsRegistry {
  recordHttp(route: string, status: string, seconds: number): void;
  recordCommand(event: CommandEvent): void;
  render(gauges?: GaugeSnapshot): string;
}

export function createMetricsRegistry(): MetricsRegistry {
  const requests = new Map<string, number>();
  const durations = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const commands = new Map<string, number>();

  return {
    recordHttp(route, status, seconds) {
      requests.set(seriesKey(route, status), (requests.get(seriesKey(route, status)) ?? 0) + 1);
      const key = seriesKey(route, status);
      let histogram = durations.get(key);
      if (!histogram) {
        histogram = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
        durations.set(key, histogram);
      }
      // Cumulative buckets, so rendering is a straight copy.
      for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) histogram.buckets[i] += 1;
      histogram.sum += seconds;
      histogram.count += 1;
    },

    recordCommand(event) {
      const key = seriesKey(event.command, event.effect, event.outcome);
      commands.set(key, (commands.get(key) ?? 0) + 1);
    },

    render(gauges = {}) {
      const lines: string[] = [];
      const metric = (name: string, type: 'counter' | 'gauge' | 'histogram', help: string) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      };
      const sample = (name: string, labels: string, value: number) =>
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`);

      const memory = process.memoryUsage();
      metric('am_process_uptime_seconds', 'gauge', 'Seconds since this process started.');
      sample('am_process_uptime_seconds', '', process.uptime());
      metric('am_process_start_time_seconds', 'gauge', 'Unix time at which this process started.');
      sample('am_process_start_time_seconds', '', Math.round((Date.now() - process.uptime() * 1000) / 1000));
      metric('am_process_resident_memory_bytes', 'gauge', 'Resident set size of this process.');
      sample('am_process_resident_memory_bytes', '', memory.rss);
      metric('am_process_heap_used_bytes', 'gauge', 'JavaScript heap in use.');
      sample('am_process_heap_used_bytes', '', memory.heapUsed);

      metric('am_process_event_loop_lag_seconds', 'gauge', 'Mean event-loop delay since the previous scrape (sampled every 10 ms).');
      const lag = eventLoopLagSeconds();
      sample('am_process_event_loop_lag_seconds', '', lag);

      metric('am_http_requests_total', 'counter', 'HTTP requests by route group and status class.');
      for (const key of [...requests.keys()].sort()) {
        const [route, status] = key.split('\u0000');
        sample('am_http_requests_total', `route=${label(route)},status=${label(status)}`, requests.get(key) ?? 0);
      }

      metric('am_http_request_duration_seconds', 'histogram', 'HTTP request duration by route group and status class, in seconds.');
      for (const key of [...durations.keys()].sort()) {
        const [route, status] = key.split('\u0000');
        const histogram = durations.get(key);
        if (!histogram) continue;
        const labels = `route=${label(route)},status=${label(status)}`;
        for (let i = 0; i < BUCKETS.length; i++)
          sample('am_http_request_duration_seconds_bucket', `${labels},le=${label(String(BUCKETS[i]))}`, histogram.buckets[i]);
        sample('am_http_request_duration_seconds_bucket', `${labels},le="+Inf"`, histogram.count);
        sample('am_http_request_duration_seconds_sum', labels, histogram.sum);
        sample('am_http_request_duration_seconds_count', labels, histogram.count);
      }

      metric('am_commands_total', 'counter', 'Command executions by command, effect and outcome.');
      for (const key of [...commands.keys()].sort()) {
        const [command, effect, outcome] = key.split('\u0000');
        sample('am_commands_total', `command=${label(command)},effect=${label(effect)},outcome=${label(outcome)}`, commands.get(key) ?? 0);
      }

      metric('am_queue_messages_pending', 'gauge', 'Messages waiting to be sent (status queued or sending).');
      if (gauges.messagesPending !== undefined) sample('am_queue_messages_pending', '', gauges.messagesPending);
      metric('am_queue_messages_oldest_seconds', 'gauge', 'Age of the oldest unsent message; how far the delivery queue is behind.');
      if (gauges.messagesOldestSeconds !== undefined) sample('am_queue_messages_oldest_seconds', '', gauges.messagesOldestSeconds);
      metric('am_journey_participants_due', 'gauge', 'Journey participants whose next step is due now.');
      if (gauges.journeyDue !== undefined) sample('am_journey_participants_due', '', gauges.journeyDue);
      metric('am_journey_participants_oldest_due_seconds', 'gauge', 'Age of the oldest journey step that is due but not processed.');
      if (gauges.journeyOldestDueSeconds !== undefined)
        sample('am_journey_participants_oldest_due_seconds', '', gauges.journeyOldestDueSeconds);
      metric('am_broadcast_runs_due', 'gauge', 'Broadcast runs past their send time that the scheduler has not finished.');
      if (gauges.broadcastDue !== undefined) sample('am_broadcast_runs_due', '', gauges.broadcastDue);
      metric('am_warehouse_exports_due', 'gauge', 'Enabled warehouse exports that are due or were asked to run.');
      if (gauges.warehouseDue !== undefined) sample('am_warehouse_exports_due', '', gauges.warehouseDue);
      metric('am_deliveries_dead_24h', 'gauge', 'Webhook and action deliveries that ended dead in the last 24 hours.');
      if (gauges.deliveriesDead24h !== undefined) sample('am_deliveries_dead_24h', '', gauges.deliveriesDead24h);

      metric('am_agent_decisions_last_hour', 'gauge', 'Agent decisions in the ledger over the last hour, per decision.');
      const decisions = new Map((gauges.agentDecisions ?? []).map((row) => [row.decision, row.count]));
      // Every decision is always present, so a dashboard shows zero instead of a gap.
      for (const decision of DECISIONS) sample('am_agent_decisions_last_hour', `decision=${label(decision)}`, decisions.get(decision) ?? 0);

      metric('am_dependency_up', 'gauge', 'Whether a dependency answered a health check on this scrape (1 up, 0 down).');
      for (const dependency of gauges.dependencies ?? [])
        sample('am_dependency_up', `name=${label(dependency.name)}`, dependency.up ? 1 : 0);

      return `${lines.join('\n')}\n`;
    },
  };
}

/** Mean event-loop delay since the previous call, in seconds; 0 before the first sample. */
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
function eventLoopLagSeconds(): number {
  const mean = eventLoop.mean;
  eventLoop.reset();
  // mean is NaN until the first sample; a fresh process has no lag worth reporting.
  return Number.isFinite(mean) ? mean / 1e9 : 0;
}

/** Race a collector against the scrape timeout, so one stuck query cannot block `/metrics`. */
async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${COLLECT_TIMEOUT_MS / 1000}s`)), COLLECT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Queue and ledger gauges, from the same queries the workers use to claim work. Read-only,
 * aggregated, and with no workspace label. A missing table (a fresh install before migrations)
 * leaves the gauge out rather than failing the scrape.
 */
export async function collectGauges(db: Db): Promise<GaugeSnapshot> {
  const gauges: GaugeSnapshot = {};
  try {
    const { rows } = await withTimeout(
      db.admin.query<{
        messages_pending: string;
        messages_oldest_seconds: string;
        journey_due: string;
        journey_oldest_due_seconds: string;
        broadcast_due: string;
        warehouse_due: string;
        deliveries_dead_24h: string;
      }>(
        `SELECT
           (SELECT count(*) FROM messages WHERE status IN ('queued', 'sending')) AS messages_pending,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - created_at)), 0) FROM messages
              WHERE status IN ('queued', 'sending')) AS messages_oldest_seconds,
           (SELECT count(*) FROM journey_participants
              WHERE status IN ('ready', 'waiting') AND due_at <= now()) AS journey_due,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - due_at)), 0) FROM journey_participants
              WHERE status IN ('ready', 'waiting') AND due_at <= now()) AS journey_oldest_due_seconds,
           (SELECT count(*) FROM broadcast_runs
              WHERE send_at <= now()
                AND (status = 'scheduled' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))) AS broadcast_due,
           (SELECT count(*) FROM warehouse_exports
              WHERE enabled AND (run_requested OR last_run_at IS NULL OR last_run_at < now() - every_minutes * interval '1 minute'))
             AS warehouse_due,
           (SELECT count(*) FROM deliveries
              WHERE status = 'dead' AND finished_at > now() - interval '24 hours') AS deliveries_dead_24h`,
      ),
      'queue gauges',
    );
    const row = rows[0];
    if (row) {
      gauges.messagesPending = Number(row.messages_pending);
      gauges.messagesOldestSeconds = Number(row.messages_oldest_seconds);
      gauges.journeyDue = Number(row.journey_due);
      gauges.journeyOldestDueSeconds = Number(row.journey_oldest_due_seconds);
      gauges.broadcastDue = Number(row.broadcast_due);
      gauges.warehouseDue = Number(row.warehouse_due);
      gauges.deliveriesDead24h = Number(row.deliveries_dead_24h);
    }
  } catch {
    // No schema yet, no permission, or too slow: the other metrics are still worth returning.
  }
  try {
    const { rows } = await withTimeout(
      db.admin.query<{ decision: string; count: string }>(
        `SELECT decision, count(*) AS count FROM agent_actions WHERE at > now() - interval '1 hour' GROUP BY decision`,
      ),
      'agent decisions',
    );
    gauges.agentDecisions = rows.map((row) => ({ decision: row.decision, count: Number(row.count) }));
  } catch {
    // As above: a scrape without the ledger is still useful.
  }
  return gauges;
}

/** A TCP connect with the scrape timeout; NATS has no ping on the event bus abstraction. */
function probeTcp(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port || 4222);
    const socket = connect({ host, port });
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(COLLECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface DependencyDeps {
  db: { ping(): Promise<void> };
  events: { ping(): Promise<boolean> };
  hot: { ping(): Promise<boolean> };
  natsUrl: string;
}

/**
 * The same checks `/readyz` makes (Postgres, ClickHouse, Valkey), plus a TCP probe for NATS,
 * as gauges instead of an all-or-nothing answer.
 */
export async function collectDependencies(deps: DependencyDeps): Promise<{ name: DependencyName; up: boolean }[]> {
  const [postgres, clickhouse, valkey, nats] = await Promise.all([
    withTimeout(deps.db.ping(), 'Postgres').then(
      () => true,
      () => false,
    ),
    withTimeout(deps.events.ping(), 'ClickHouse').then(
      (ok) => ok === true,
      () => false,
    ),
    withTimeout(deps.hot.ping(), 'Valkey').then(
      (ok) => ok === true,
      () => false,
    ),
    withTimeout(probeTcp(deps.natsUrl), 'NATS'),
  ]);
  return [
    { name: 'postgres', up: postgres },
    { name: 'clickhouse', up: clickhouse },
    { name: 'nats', up: nats },
    { name: 'valkey', up: valkey },
  ];
}
