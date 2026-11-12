import { type AnalyticsResult, runAnalyticsQuery } from '@agentic-marketing/analytics';
import { newId } from '@agentic-marketing/core';
import { type AlertChannel, type AlertNotification, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AlertDeps } from './deps';
import { mergeNotifications, notifyChannels, reconcileAlertNotifications } from './notify';
import {
  type AlertConfig,
  type DeliverabilityConfig,
  type JourneyErrorsConfig,
  minimumIntervalMs,
  parseAlertConfig,
  type SignupDropConfig,
  windowMs,
} from './rules';

// Evaluation reads every rule through the metric layer, never with alert-specific SQL. A rule that
// is still firing has an open event, so a second tick finds it instead of notifying again; the
// unique open-event index is the database's half of that promise.

const COOLDOWN_MS = 3_600_000;
const CONFIRMED_SIGNUP = 'Subscription Confirmed';

type RuleRow = typeof schema.alertRules.$inferSelect;

/**
 * How many consecutive failures a rule may retry on every tick before it keeps the per-rule
 * minimum interval. A transient ClickHouse blip is retried five minutes later; a rule that is
 * genuinely broken must not keep querying analytics every tick forever.
 */
const FAILURES_BEFORE_BACKOFF = 3;

interface RuleEvaluationState {
  /** Last measurement that produced a decision. The minimum interval is measured from it. */
  lastSuccessAt?: number;
  /** Last attempt, including failures. The failure back-off is measured from it. */
  lastAttemptAt?: number;
  /** Consecutive failed measurements; a successful measurement (including a skip) resets it. */
  failures: number;
}

/** Load shaping only: a failed or skipped measurement is never recorded as an evaluation. */
const evaluationState = new Map<string, RuleEvaluationState>();

export function resetAlertEvaluationState() {
  evaluationState.clear();
}

export interface EvaluateOptions {
  now?: Date;
  /** Ignore the minimum interval (tests, or a manual run). Dedupe still applies. */
  force?: boolean;
}

export interface EvaluatedMeasurement {
  firing: boolean;
  value: number;
  threshold: number;
  window: string;
  previous?: number;
  config: AlertConfig;
  /** Not enough data to make a decision; leave the current state (and open episode) alone. */
  skip?: boolean;
}

function measureValue(result: AnalyticsResult, name: string): number | null {
  const index = result.columns.findIndex((c) => c.name === name);
  if (index < 0) return null;
  const value = result.rows[0]?.[index];
  return typeof value === 'number' ? value : null;
}

function range(now: Date, window: string): { from: string; to: string } {
  return { from: new Date(now.getTime() - windowMs(window)).toISOString(), to: now.toISOString() };
}

async function evaluateDeliverability(
  deps: AlertDeps,
  tx: Tx,
  workspaceId: string,
  config: DeliverabilityConfig,
  now: Date,
): Promise<EvaluatedMeasurement> {
  const measure = config.metric === 'complaint' ? 'email.complaint_rate' : 'email.bounce_rate';
  const { from, to } = range(now, config.window);
  const result = await runAnalyticsQuery(
    { tx, events: deps.events, workspaceId },
    { measures: [measure, 'email.sent'], dimensions: [], from, to, limit: 1 },
  );
  const sent = measureValue(result, 'email.sent') ?? 0;
  const rate = measureValue(result, measure);
  // A minimum sample protects people from a rule that fires on two sends and one bounce. Below
  // it there is no decision at all: a quiet window must not also resolve an open incident.
  if (sent < config.minSent)
    return { firing: false, value: rate ?? 0, threshold: config.threshold, window: config.window, config, skip: true };
  const firing = rate !== null && rate > config.threshold;
  return { firing, value: rate ?? 0, threshold: config.threshold, window: config.window, config };
}

async function evaluateSignupDrop(
  deps: AlertDeps,
  tx: Tx,
  workspaceId: string,
  config: SignupDropConfig,
  now: Date,
): Promise<EvaluatedMeasurement> {
  const current = range(now, config.window);
  const previousTo = new Date(now.getTime() - windowMs(config.window));
  const previousFrom = new Date(previousTo.getTime() - windowMs(config.window));
  const query = (from: string, to: string) =>
    runAnalyticsQuery(
      { tx, events: deps.events, workspaceId },
      {
        measures: ['conversions'],
        dimensions: [],
        from,
        to,
        filters: { name: [CONFIRMED_SIGNUP] },
        limit: 1,
      },
    );
  const [currentResult, previousResult] = await Promise.all([
    query(current.from, current.to),
    query(previousFrom.toISOString(), previousTo.toISOString()),
  ]);
  const value = measureValue(currentResult, 'conversions') ?? 0;
  const previous = measureValue(previousResult, 'conversions') ?? 0;
  const threshold = previous * (1 - config.dropPercent / 100);
  // Below the previous-window floor the comparison is too thin to act on.
  const skip = previous < config.minPrevious;
  const firing = !skip && value < threshold;
  return { firing, value, threshold, window: config.window, previous, config, skip };
}

async function evaluateJourneyErrors(
  deps: AlertDeps,
  tx: Tx,
  workspaceId: string,
  config: JourneyErrorsConfig,
  now: Date,
): Promise<EvaluatedMeasurement> {
  const { from, to } = range(now, config.window);
  const result = await runAnalyticsQuery(
    { tx, events: deps.events, workspaceId },
    {
      measures: ['journey.failed'],
      dimensions: [],
      from,
      to,
      ...(config.journeyId ? { filters: { journey: [config.journeyId] } } : {}),
      limit: 1,
    },
  );
  const value = measureValue(result, 'journey.failed') ?? 0;
  return { firing: value > config.threshold, value, threshold: config.threshold, window: config.window, config };
}

async function measureRule(deps: AlertDeps, tx: Tx, rule: RuleRow, now: Date): Promise<EvaluatedMeasurement> {
  const config = parseAlertConfig(rule.kind, rule.config);
  switch (rule.kind) {
    case 'deliverability':
      return evaluateDeliverability(deps, tx, rule.workspaceId, config as DeliverabilityConfig, now);
    case 'signup_drop':
      return evaluateSignupDrop(deps, tx, rule.workspaceId, config as SignupDropConfig, now);
    case 'journey_errors':
      return evaluateJourneyErrors(deps, tx, rule.workspaceId, config as JourneyErrorsConfig, now);
  }
}

/**
 * Channels that still need a send for this event. Only `sent` suppresses a channel permanently;
 * `queued` is already in the outbox (a second insert would be a duplicate), and `failed` is
 * retried unless the bounded delivery budget marked it exhausted.
 */
export function pendingChannels(
  channels: AlertChannel[],
  notified: AlertNotification[],
  event: AlertNotification['event'],
): AlertChannel[] {
  const sent = new Set(notified.filter((n) => n.event === event && n.status === 'sent').map((n) => `${n.channel}:${n.target}`));
  const inFlight = new Set(notified.filter((n) => n.event === event && n.status === 'queued').map((n) => `${n.channel}:${n.target}`));
  const exhausted = new Set(
    notified.filter((n) => n.event === event && n.status === 'failed' && n.retryable === false).map((n) => `${n.channel}:${n.target}`),
  );
  const pending = (key: string) => !sent.has(key) && !inFlight.has(key) && !exhausted.has(key);
  const out: AlertChannel[] = [];
  for (const channel of channels) {
    if (channel.type === 'webhook') {
      if (pending(`webhook:${channel.webhookId}`)) out.push(channel);
      continue;
    }
    const userIds = channel.userIds.filter((id) => pending(`email:${id}`));
    if (userIds.length) out.push({ type: 'email', userIds });
  }
  return out;
}

async function notifyFor(
  tx: Tx,
  deps: AlertDeps,
  rule: RuleRow,
  workspace: { id: string; name: string },
  eventId: string,
  event: 'firing' | 'resolved',
  measurement: EvaluatedMeasurement,
  existing: AlertNotification[],
  now: Date,
): Promise<AlertNotification[]> {
  const channels = pendingChannels(rule.channels, existing, event);
  if (!channels.length) return existing;
  const fresh = await notifyChannels(
    tx,
    deps,
    {
      workspace,
      rule: { id: rule.id, name: rule.name, kind: rule.kind, config: measurement.config },
      eventId,
      event,
      value: measurement.value,
      threshold: measurement.threshold,
      window: measurement.window,
      ...(measurement.previous === undefined ? {} : { previous: measurement.previous }),
      now,
    },
    channels,
    existing,
  );
  return mergeNotifications(existing, fresh);
}

async function evaluateRule(deps: AlertDeps, tx: Tx, rule: RuleRow, now: Date, opts: EvaluateOptions) {
  const key = `${rule.workspaceId}:${rule.id}`;
  const config = parseAlertConfig(rule.kind, rule.config);
  const interval = minimumIntervalMs(config);
  const state = evaluationState.get(key) ?? { failures: 0 };
  if (!opts.force) {
    // A rule that keeps failing backs off after a few retries, so a broken rule does not hammer
    // ClickHouse every five minutes; until then a failure is retried on the next tick.
    if (state.failures >= FAILURES_BEFORE_BACKOFF && state.lastAttemptAt !== undefined && now.getTime() - state.lastAttemptAt < interval)
      return;
    // Only a successful measurement starts the minimum interval. Failures and skips retry next tick.
    if (state.lastSuccessAt !== undefined && now.getTime() - state.lastSuccessAt < interval) return;
  }
  state.lastAttemptAt = now.getTime();
  evaluationState.set(key, state);

  const workspace = await tx
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, rule.workspaceId));
  if (!workspace[0]) return;

  let measurement: EvaluatedMeasurement;
  try {
    measurement = await measureRule(deps, tx, rule, now);
  } catch (err) {
    state.failures++;
    // Once per failure streak: the retries and the back-off are expected, not new incidents.
    if (state.failures === 1)
      logger.error({ err, rule: rule.id, workspaceId: rule.workspaceId }, 'alert evaluation failed; retrying on the next tick');
    return;
  }
  state.failures = 0;
  if (measurement.skip) return;
  state.lastSuccessAt = now.getTime();

  const [open] = await tx
    .select()
    .from(schema.alertEvents)
    .where(and(eq(schema.alertEvents.ruleId, rule.id), isNull(schema.alertEvents.resolvedAt)))
    .orderBy(desc(schema.alertEvents.firedAt))
    .limit(1);

  if (measurement.firing) {
    if (open) {
      // Still firing: first make the ledger truthful against the outbox (a queued delivery that
      // turned dead is failed, a completed one is sent), then retry only channels that still need
      // it, never re-notify the rest.
      const existing = await reconcileAlertNotifications(tx, open.notified);
      const notified = await notifyFor(tx, deps, rule, workspace[0], open.id, 'firing', measurement, existing, now);
      if (notified !== open.notified) await tx.update(schema.alertEvents).set({ notified }).where(eq(schema.alertEvents.id, open.id));
      return;
    }

    // After a resolve, stay quiet for an hour so a flapping metric cannot storm.
    const [resolved] = await tx
      .select({ resolvedAt: schema.alertEvents.resolvedAt })
      .from(schema.alertEvents)
      .where(and(eq(schema.alertEvents.ruleId, rule.id), eq(schema.alertEvents.state, 'resolved')))
      .orderBy(desc(schema.alertEvents.resolvedAt))
      .limit(1);
    if (resolved?.resolvedAt && now.getTime() - resolved.resolvedAt.getTime() < COOLDOWN_MS) return;

    const [created] = await tx
      .insert(schema.alertEvents)
      .values({
        workspaceId: rule.workspaceId,
        id: newId('ale'),
        ruleId: rule.id,
        state: 'firing',
        value: measurement.value,
        threshold: measurement.threshold,
        window: measurement.window,
        firedAt: now,
        notified: [],
      })
      .onConflictDoNothing()
      .returning();
    if (!created) return;
    const notified = await notifyFor(tx, deps, rule, workspace[0], created.id, 'firing', measurement, [], now);
    await tx.update(schema.alertEvents).set({ notified }).where(eq(schema.alertEvents.id, created.id));
    return;
  }

  if (!open) return;
  // Not firing any more: notify resolution once and keep the row as history. The firing ledger is
  // reconciled first so a delivery still in flight is reported truthfully even as the episode closes.
  const existing = await reconcileAlertNotifications(tx, open.notified);
  const notified = await notifyFor(tx, deps, rule, workspace[0], open.id, 'resolved', measurement, existing, now);
  await tx
    .update(schema.alertEvents)
    .set({
      state: 'resolved',
      value: measurement.value,
      threshold: measurement.threshold,
      window: measurement.window,
      resolvedAt: now,
      notified,
    })
    .where(eq(schema.alertEvents.id, open.id));
}

async function evaluateWorkspace(deps: AlertDeps, tx: Tx, now: Date, opts: EvaluateOptions) {
  const rules = await tx.select().from(schema.alertRules).where(eq(schema.alertRules.enabled, true));
  for (const rule of rules) await evaluateRule(deps, tx, rule, now, opts);
}

/**
 * Makes queued alert notifications truthful even when no enabled rule will evaluate their event
 * (#368): a rule that was disabled, republished away or resolved must not leave a ledger entry
 * saying `queued` forever. Bounded per tick; it retries the original outbox row within its durable budget.
 */
export async function reconcileQueuedAlertEvents(deps: AlertDeps): Promise<number> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM alert_events
     WHERE (notified @> '[{"status":"queued"}]'::jsonb OR notified @> '[{"status":"failed","retryable":true}]'::jsonb)
     LIMIT 100`,
  );
  let reconciled = 0;
  for (const { workspace_id: workspaceId } of rows) {
    try {
      reconciled += await deps.db.withWorkspace(workspaceId, async (tx) => {
        const events = await tx.execute<{ id: string; notified: AlertNotification[] }>(sql`
          SELECT id, notified FROM alert_events
          WHERE (notified @> '[{"status":"queued"}]'::jsonb OR notified @> '[{"status":"failed","retryable":true}]'::jsonb)
          ORDER BY fired_at
          LIMIT 200`);
        let changed = 0;
        for (const event of events.rows) {
          const notified = await reconcileAlertNotifications(tx, event.notified, { retry: true });
          if (notified !== event.notified) {
            await tx.update(schema.alertEvents).set({ notified }).where(eq(schema.alertEvents.id, event.id));
            changed++;
          }
        }
        return changed;
      });
    } catch (err) {
      logger.error({ err, workspaceId }, 'alert notification reconciliation failed');
    }
  }
  return reconciled;
}

/** One sweep over every workspace. The scheduler calls this; tests call it with a fixed clock. */
export async function evaluateAlerts(deps: AlertDeps, opts: EvaluateOptions = {}) {
  const now = opts.now ?? new Date();
  // Independent of `enabled` on purpose: a rule switched off mid-flight still has deliveries to
  // reconcile (the outbox delivers them regardless).
  await reconcileQueuedAlertEvents(deps);
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
    'SELECT DISTINCT workspace_id FROM alert_rules WHERE enabled = true',
  );
  for (const { workspace_id: workspaceId } of rows) {
    try {
      await deps.db.withWorkspace(workspaceId, (tx) => evaluateWorkspace(deps, tx, now, opts));
    } catch (err) {
      logger.error({ err, workspaceId }, 'alert workspace evaluation failed');
    }
  }
}

export interface AlertEvaluatorOptions {
  tickMs?: number;
  /** A clock for tests; the scheduler uses the wall clock. */
  now?: () => Date;
  force?: boolean;
}

/** The scheduler job: every five minutes by default, each rule no more than four times per window. */
export async function runAlertEvaluator(deps: AlertDeps, signal: AbortSignal, opts: AlertEvaluatorOptions = {}) {
  const tickMs = opts.tickMs ?? 5 * 60_000;
  logger.info('scheduler role: threshold alerts');
  while (!signal.aborted) {
    try {
      await evaluateAlerts(deps, { now: opts.now?.() ?? new Date(), force: opts.force });
    } catch (err) {
      logger.error({ err }, 'alert evaluation round failed');
    }
    if (signal.aborted) break;
    // Abort-aware: a scheduler role stopping must not wait out a five-minute (or test) tick.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
