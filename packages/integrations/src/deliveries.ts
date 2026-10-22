import { AppError } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { connectionSecrets, connectorOf, runAction } from './connections';
import { type EgressPolicy, safeRequest } from './egress';
import { webhookHeaders } from './signing';
import { endpointSecret } from './webhooks';

// The delivery worker: sends due webhook deliveries and runs connector actions, outside any
// transaction. Webhooks retry with backoff and end "dead" after the last attempt; actions a
// journey waits for retry briefly, then wake the participant with the result or the error.

export interface DeliveryDeps {
  kp: KeyProvider;
  egress: EgressPolicy;
  /** Shared rate limits across workers; without it each process counts on its own. */
  hot?: Pick<HotState, 'take'>;
  /** Delay before each retry; the delivery is dead (webhooks) or failed (actions) after the last. */
  webhookBackoffMs?: number[];
  actionBackoffMs?: number[];
}

const WEBHOOK_BACKOFF = [10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const ACTION_BACKOFF = [5_000, 30_000];
const LEASE_MS = 60_000;

type Row = typeof schema.deliveries.$inferSelect;

/** Token bucket per connection, for connectors that declare a rate limit (calls per minute). */
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

type Outcome =
  | { ok: true; statusCode?: number; response: unknown }
  | { ok: false; statusCode?: number; error: string; permanent?: boolean };

/**
 * Handlers for delivery kinds other packages add (e.g. ad conversions). They return the outcome
 * like webhooks do; `permanent` failures are not retried.
 */
export const deliveryHandlers = new Map<string, (db: Db, d: Row, deps: DeliveryDeps) => Promise<Outcome | 'later'>>();
export type DeliveryOutcome = Outcome;
export type DeliveryRow = Row;

async function attempt(db: Db, d: Row, deps: DeliveryDeps): Promise<Outcome | 'later'> {
  const handler = deliveryHandlers.get(d.kind);
  if (handler) return handler(db, d, deps);
  if (d.kind === 'webhook') {
    const target = await db.withWorkspace(d.workspaceId, async (tx) => {
      const [e] = await tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, d.targetId));
      return e?.enabled ? { url: e.url, secret: await endpointSecret(tx, e, deps.kp) } : null;
    });
    if (!target) return { ok: false, error: 'the endpoint was deleted or disabled', permanent: true };
    const body = JSON.stringify(d.payload);
    const res = await safeRequest(target.url, { method: 'POST', headers: webhookHeaders(target.secret, d.id, body), body }, deps.egress);
    if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, response: res.body.slice(0, 2000) };
    return { ok: false, statusCode: res.status, error: `HTTP ${res.status}: ${res.body.slice(0, 300)}`, permanent: res.status === 410 };
  }
  const conn = await db.withWorkspace(d.workspaceId, async (tx) => {
    const [c] = await tx.select().from(schema.connections).where(eq(schema.connections.id, d.targetId));
    return c?.enabled ? { row: c, secrets: await connectionSecrets(tx, c, deps.kp) } : null;
  });
  if (!conn) return { ok: false, error: 'the connection was deleted or disabled', permanent: true };
  const limit = connectorOf(conn.row.connector).rateLimit;
  if (limit && !(deps.hot ? await deps.hot.take(`con:${conn.row.id}`, 1, limit / 60, limit) : takeToken(conn.row.id, limit)))
    return 'later';
  const result = await runAction(conn.row, conn.secrets, d.action ?? '', d.payload, deps.egress);
  return { ok: true, response: result ?? null };
}

/** Stores an action's outcome on the participant waiting at its step, and wakes it. */
async function wake(db: Db, d: Row, outcome: { ok: boolean; result?: unknown; error?: string }) {
  if (d.participantId === null) return;
  const value = JSON.stringify({ seq: d.seq, ...outcome });
  await db.withWorkspace(d.workspaceId, (tx) =>
    tx.execute(sql`
      UPDATE journey_participants SET
        context = jsonb_set(context, '{results}', coalesce(context->'results', '{}') || jsonb_build_object(${d.node}::text, ${value}::jsonb)),
        due_at = now(), updated_at = now()
      WHERE workspace_id = ${d.workspaceId} AND id = ${d.participantId} AND node = ${d.node} AND seq = ${d.seq} AND status = 'waiting'`),
  );
}

async function handle(db: Db, d: Row, deps: DeliveryDeps) {
  const started = Date.now();
  let out: Outcome | 'later';
  try {
    out = await attempt(db, d, deps);
  } catch (err) {
    out = { ok: false, error: (err as Error).message, permanent: err instanceof AppError };
  }
  const set = (values: Partial<Row>) =>
    db.withWorkspace(d.workspaceId, (tx) =>
      tx
        .update(schema.deliveries)
        .set({ leaseUntil: null, durationMs: Date.now() - started, ...values })
        .where(and(eq(schema.deliveries.workspaceId, d.workspaceId), eq(schema.deliveries.id, d.id))),
    );
  if (out === 'later')
    return set({ status: 'pending', attempts: d.attempts - 1, nextAttemptAt: new Date(Date.now() + 1000), durationMs: null });
  if (out.ok) {
    await set({ status: 'done', statusCode: out.statusCode ?? null, response: out.response, error: null, finishedAt: new Date() });
    return wake(db, d, { ok: true, result: out.response });
  }
  const backoff = d.kind === 'action' ? (deps.actionBackoffMs ?? ACTION_BACKOFF) : (deps.webhookBackoffMs ?? WEBHOOK_BACKOFF);
  const last = out.permanent || d.attempts > backoff.length;
  if (!last)
    return set({
      status: 'pending',
      statusCode: out.statusCode ?? null,
      error: out.error,
      nextAttemptAt: new Date(Date.now() + backoff[d.attempts - 1]),
    });
  await set({
    status: d.kind === 'action' ? 'failed' : 'dead',
    statusCode: out.statusCode ?? null,
    error: out.error,
    finishedAt: new Date(),
  });
  logger.warn({ delivery: d.id, target: d.targetId, error: out.error }, 'delivery gave up');
  return wake(db, d, { ok: false, error: out.error });
}

/** One round: claims due deliveries per workspace and handles them concurrently. Returns how many. */
export async function deliverDue(db: Db, deps: DeliveryDeps, opts: { batch?: number } = {}): Promise<number> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM deliveries
     WHERE next_attempt_at <= now() AND (status = 'pending' OR (status = 'running' AND lease_until < now())) LIMIT 100`,
  );
  let handled = 0;
  for (const { workspace_id: ws } of rows) {
    const claimed = await db.withWorkspace(ws, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE deliveries SET status = 'running', lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = attempts + 1
        WHERE workspace_id = ${ws} AND id IN (
          SELECT id FROM deliveries
          WHERE next_attempt_at <= now() AND (status = 'pending' OR (status = 'running' AND lease_until < now()))
          ORDER BY next_attempt_at LIMIT ${opts.batch ?? 20} FOR UPDATE SKIP LOCKED)
        RETURNING id`);
      if (!res.rows.length) return [];
      return tx
        .select()
        .from(schema.deliveries)
        .where(
          inArray(
            schema.deliveries.id,
            res.rows.map((r) => r.id),
          ),
        );
    });
    await Promise.all(
      claimed.map((d) => handle(db, d, deps).catch((err) => logger.error({ err, delivery: d.id }, 'delivery round failed'))),
    );
    handled += claimed.length;
  }
  return handled;
}

export async function runDeliveries(db: Db, deps: DeliveryDeps, signal: AbortSignal) {
  while (!signal.aborted) {
    let handled = 0;
    try {
      handled = await deliverDue(db, deps);
    } catch (err) {
      logger.error({ err }, 'delivery worker round failed');
    }
    if (!handled) await new Promise((r) => setTimeout(r, 250));
  }
}
