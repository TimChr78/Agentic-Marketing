import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { MEASURES, runAnalyticsQuery } from '@agentic-marketing/analytics';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { nextRolloutStep } from '@agentic-marketing/personalize';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';

// The experience rollout scheduler (#427): advances a published ramp to its next step when the step
// has run its hours and the metric-layer guardrail still holds. When the guardrail fails it pauses
// at the current step and tells the workspace owners, like the guardian does for an agent. The edge
// bundle and the decision API are invalidated so the new share applies without a republish.
//
// Each ramp is swept in its own transaction (#474): a failing measure or lock freezes only that
// ramp, and everything committed for the other ramps stays committed. The pause itself is written
// with the ramp; the owner e-mail is sent from that durable pause row after the transaction
// commits (#473), once per pause, and the agent event sweep reads the same row (#476).

const HOUR_MS = 3_600_000;
const MAX_PAUSES_PER_RUN = 100;
/** A pause e-mail is tried at most this many times before it is left for a person (#473). */
const NOTIFY_MAX_ATTEMPTS = 6;
/** A claim older than this is treated as a crashed attempt and may be retried (#473). */
const NOTIFY_LEASE_MS = 10 * 60_000;
/** Retry delay after a failed attempt, doubling from 15 s up to an hour (#473). */
const notifyBackoffMs = (attempts: number) => Math.min(HOUR_MS, 15_000 * 2 ** Math.max(0, attempts - 1));

export interface GuardrailReading {
  at: string;
  measure: string;
  value: number;
  baseline: number;
  dropPercent: number;
  ok: boolean;
}

export type MeasureGuardrail = (
  tx: Tx,
  workspaceId: string,
  guardrail: { measure: string; maxDropPercent: number },
  stepHours: number,
  now: Date,
) => Promise<GuardrailReading | null>;

export interface RolloutDeps extends NotifyDeps {
  db: Db;
  events: EventStore;
  hot: HotState;
  /** Reads the metric layer; tests inject a reading instead. */
  measure?: MeasureGuardrail;
}

export interface RolloutSummary {
  checked: number;
  advanced: number;
  paused: number;
  /** Ramps whose guardrail read or step failed this round; each one waits and retries alone (#474). */
  failed: number;
}

function measureValue(result: Awaited<ReturnType<typeof runAnalyticsQuery>>, name: string): number | null {
  const index = result.columns.findIndex((c) => c.name === name);
  if (index < 0) return null;
  const value = result.rows[0]?.[index];
  return typeof value === 'number' ? value : null;
}

/**
 * The production guardrail: the measure over the last step's hours, against the same length before
 * it. A rate or a count that falls further than maxDropPercent pauses the ramp. Too little history
 * is not a pass and not a failure: the ramp waits for another tick.
 */
async function readGuardrail(
  deps: RolloutDeps,
  tx: Tx,
  workspaceId: string,
  guardrail: { measure: string; maxDropPercent: number },
  stepHours: number,
  now: Date,
): Promise<GuardrailReading | null> {
  if (deps.measure) return deps.measure(tx, workspaceId, guardrail, stepHours, now);
  if (!MEASURES[guardrail.measure]) return null;
  const span = Math.min(Math.max(stepHours, 1), 168) * HOUR_MS;
  const from = new Date(now.getTime() - span);
  const previousFrom = new Date(now.getTime() - 2 * span);
  const query = (start: Date, end: Date) =>
    runAnalyticsQuery(
      { tx, events: deps.events, workspaceId },
      { measures: [guardrail.measure], dimensions: [], from: start.toISOString(), to: end.toISOString(), limit: 1 },
    );
  const [current, previous] = await Promise.all([query(from, now), query(previousFrom, from)]);
  const value = measureValue(current, guardrail.measure);
  const baseline = measureValue(previous, guardrail.measure);
  // A zero or missing baseline has nothing to compare with; the ramp waits rather than widening.
  if (value === null || baseline === null || baseline <= 0) return null;
  const dropPercent = ((baseline - value) / baseline) * 100;
  return {
    at: now.toISOString(),
    measure: guardrail.measure,
    value,
    baseline,
    dropPercent,
    ok: dropPercent <= guardrail.maxDropPercent,
  };
}

/** The owner e-mail for one committed pause (#473): the pause row, not the sweep clock, is the key. */
async function notifyPaused(
  tx: Tx,
  deps: RolloutDeps,
  workspaceId: string,
  pause: typeof schema.experienceRolloutPauses.$inferSelect,
  name: string,
) {
  const members = await tx
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(schema.workspaceMembers.role, ['owner', 'admin'])));
  if (!members.length) return [];
  const url = `${deps.publicUrl.replace(/\/$/, '')}/marketing/experiences/${encodeURIComponent(pause.artifactId)}`;
  const reading = pause.reading ?? null;
  const subject = `Experience ramp paused: ${name}`;
  const text = [
    `The ramp on “${name}” was paused at ${pause.share}% of visitors.`,
    '',
    reading
      ? `Guardrail: ${reading.measure} fell ${reading.dropPercent.toFixed(1)}% (from ${reading.baseline} to ${reading.value}); the ramp allows ${pause.guardrail?.maxDropPercent ?? 0}%.`
      : 'Guardrail: the ramp failed.',
    `Reason: ${pause.reason ?? 'guardrail failed'}`,
    '',
    `Review the experience: ${url}`,
    '',
    'The share stays where it is and does not widen until a person resumes or stops the ramp.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>The ramp on <strong>${name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</strong> was paused at ${pause.share}% of visitors.</p>
<p>${reading ? `Guardrail: ${reading.measure} fell ${reading.dropPercent.toFixed(1)}% (from ${reading.baseline} to ${reading.value}); the ramp allows ${pause.guardrail?.maxDropPercent ?? 0}%.` : 'Guardrail: the ramp failed.'}</p>
<p><a href="${url.replaceAll('"', '&quot;')}">Review the experience</a></p>
</body></html>`;
  return sendMemberEmails(
    tx,
    deps,
    workspaceId,
    members.map((m) => ({
      userId: m.userId,
      idempotencyKey: `experience-rollout:${pause.artifactId}:${pause.pausedAt.toISOString()}:${m.userId}`,
      subject,
      text,
      html,
    })),
  );
}

interface SweptRamp {
  checked: number;
  advanced: number;
  paused: number;
}

/**
 * One due ramp, in its own transaction. Reading the guardrail can throw (a slow or failing metric
 * store); that aborts only this ramp's transaction and the caller records the error and moves on.
 */
async function sweepRamp(deps: RolloutDeps, tx: Tx, workspaceId: string, artifactId: string, now: Date): Promise<SweptRamp> {
  const [found] = await tx
    .select({ row: schema.experienceRollouts })
    .from(schema.experienceRollouts)
    .innerJoin(
      schema.artifacts,
      and(
        eq(schema.artifacts.workspaceId, schema.experienceRollouts.workspaceId),
        eq(schema.artifacts.id, schema.experienceRollouts.artifactId),
        eq(schema.artifacts.publishedVersion, schema.experienceRollouts.version),
        eq(schema.artifacts.type, 'experience'),
        eq(schema.artifacts.archived, false),
      ),
    )
    .where(
      and(
        eq(schema.experienceRollouts.workspaceId, workspaceId),
        eq(schema.experienceRollouts.artifactId, artifactId),
        eq(schema.experienceRollouts.status, 'running'),
        lte(schema.experienceRollouts.nextStepAt, now),
      ),
    )
    // Serialize replicas: the loser rechecks next_step_at after the winner commits and skips the row.
    .for('update', { of: schema.experienceRollouts });
  // Another replica advanced or stopped it after the due list was read.
  if (!found) return { checked: 0, advanced: 0, paused: 0 };
  const { row } = found;
  const out: SweptRamp = { checked: 1, advanced: 0, paused: 0 };
  let reading: GuardrailReading | null = null;
  if (row.guardrail) reading = await readGuardrail(deps, tx, workspaceId, row.guardrail, row.stepHours, now);
  if (reading && !reading.ok) {
    const reason = `${reading.measure} fell ${reading.dropPercent.toFixed(1)}% (from ${reading.baseline} to ${reading.value}); the ramp allows ${row.guardrail?.maxDropPercent ?? 0}%`;
    const [paused] = await tx
      .update(schema.experienceRollouts)
      .set({
        status: 'paused',
        pausedAt: now,
        nextStepAt: null,
        lastGuardrail: reading,
        lastError: null,
        reason,
        updatedAt: now,
        updatedBy: 'scheduler',
      })
      .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)))
      .returning();
    // The durable pause row: the owner e-mail and the agent event are delivered from it, after this
    // transaction commits, once per pause (#473, #476).
    if (paused)
      await tx
        .insert(schema.experienceRolloutPauses)
        .values({
          workspaceId,
          artifactId: paused.artifactId,
          version: paused.version,
          pausedAt: now,
          stepIndex: paused.stepIndex,
          share: paused.share,
          reason,
          guardrail: row.guardrail ?? null,
          reading,
        })
        .onConflictDoNothing();
    out.paused++;
    await tx.update(schema.edgeTargets).set({ bundleHash: null });
    return out;
  }
  if (reading)
    await tx
      .update(schema.experienceRollouts)
      .set({ lastGuardrail: reading, lastError: null, updatedAt: now })
      .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
  // Without a reading the step waits: a missing baseline must not quietly widen the ramp.
  if (row.guardrail && !reading) return out;
  const next = nextRolloutStep(row, now);
  if (!next) {
    await tx
      .update(schema.experienceRollouts)
      .set({ status: 'complete', nextStepAt: null, lastError: null, updatedAt: now })
      .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
    return out;
  }
  await tx
    .update(schema.experienceRollouts)
    .set({
      stepIndex: next.stepIndex,
      share: next.share,
      status: next.status,
      advancedAt: now,
      nextStepAt: next.nextStepAt,
      lastError: null,
      updatedAt: now,
      updatedBy: 'scheduler',
    })
    .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
  // The edge bundle carries the share; clearing the hash makes the next sync push it.
  await tx.update(schema.edgeTargets).set({ bundleHash: null });
  out.advanced++;
  return out;
}

/** Records why one ramp could not be swept, without touching any other ramp (#474). */
async function recordRampError(deps: RolloutDeps, workspaceId: string, artifactId: string, err: unknown, now: Date) {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 500);
  await deps.db.withWorkspace(workspaceId, (tx) =>
    tx
      .update(schema.experienceRollouts)
      .set({ lastError: message, updatedAt: now })
      .where(
        and(
          eq(schema.experienceRollouts.workspaceId, workspaceId),
          eq(schema.experienceRollouts.artifactId, artifactId),
          eq(schema.experienceRollouts.status, 'running'),
        ),
      ),
  );
}

type PauseKey = { workspaceId: string; artifactId: string; pausedAt: Date };

/**
 * Claims one pause row for the owner e-mail in its own committed transaction (#473). The claim is
 * written before any provider call: another replica sees `notifying_at` and leaves it alone, and a
 * crash during the send leaves the row retryable after the lease. `notify_after` backs off a
 * failure and `notify_attempts` bounds it so a permanently failing address cannot retry forever.
 */
async function claimPause(
  deps: RolloutDeps,
  key: PauseKey,
): Promise<{ pause: typeof schema.experienceRolloutPauses.$inferSelect; name: string } | null> {
  return deps.db.withWorkspace(key.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ pause: schema.experienceRolloutPauses, name: schema.artifacts.name })
      .from(schema.experienceRolloutPauses)
      .innerJoin(
        schema.artifacts,
        and(
          eq(schema.artifacts.workspaceId, schema.experienceRolloutPauses.workspaceId),
          eq(schema.artifacts.id, schema.experienceRolloutPauses.artifactId),
        ),
      )
      .where(
        and(
          eq(schema.experienceRolloutPauses.workspaceId, key.workspaceId),
          eq(schema.experienceRolloutPauses.artifactId, key.artifactId),
          eq(schema.experienceRolloutPauses.pausedAt, key.pausedAt),
          isNull(schema.experienceRolloutPauses.notifiedAt),
        ),
      )
      .for('update', { of: schema.experienceRolloutPauses });
    if (!found) return null;
    const now = new Date();
    if (found.pause.notifyAttempts >= NOTIFY_MAX_ATTEMPTS) return null;
    if (found.pause.notifyAfter && found.pause.notifyAfter > now) return null;
    if (found.pause.notifyingAt && now.getTime() - found.pause.notifyingAt.getTime() < NOTIFY_LEASE_MS) return null;
    const [claimed] = await tx
      .update(schema.experienceRolloutPauses)
      .set({ notifyingAt: now, notifyAttempts: found.pause.notifyAttempts + 1 })
      .where(
        and(
          eq(schema.experienceRolloutPauses.workspaceId, key.workspaceId),
          eq(schema.experienceRolloutPauses.artifactId, key.artifactId),
          eq(schema.experienceRolloutPauses.pausedAt, key.pausedAt),
        ),
      )
      .returning();
    return claimed ? { pause: claimed, name: found.name } : null;
  });
}

/**
 * Sends the owner e-mail for one pause after claiming it, then records the outcome in a second
 * commit (#473). A failure leaves the pause unnotified with a backoff and a bounded attempt count,
 * so it is retried instead of being marked as sent. The message key stays the pause row, so a crash
 * after the provider accepted the message at most duplicates one send: at least once, de-duplicated
 * by key where the provider supports it; the messages table also skips a send already recorded.
 */
async function deliverPause(deps: RolloutDeps, key: PauseKey): Promise<'sent' | 'failed' | 'skipped'> {
  const claim = await claimPause(deps, key);
  if (!claim) return 'skipped';
  const attempt = claim.pause.notifyAttempts;
  const recordFailure = (message: string) =>
    deps.db
      .withWorkspace(key.workspaceId, (tx) =>
        tx
          .update(schema.experienceRolloutPauses)
          .set({
            notifyingAt: null,
            notifyError: message.slice(0, 500),
            notifyAfter: attempt < NOTIFY_MAX_ATTEMPTS ? new Date(Date.now() + notifyBackoffMs(attempt)) : null,
          })
          .where(
            and(
              eq(schema.experienceRolloutPauses.workspaceId, key.workspaceId),
              eq(schema.experienceRolloutPauses.artifactId, key.artifactId),
              eq(schema.experienceRolloutPauses.pausedAt, key.pausedAt),
            ),
          ),
      )
      .catch((err) => logger.error({ err, artifact: key.artifactId }, 'could not record a rollout e-mail failure'));
  try {
    return await deps.db.withWorkspace(key.workspaceId, async (tx) => {
      const results = await notifyPaused(tx, deps, key.workspaceId, claim.pause, claim.name);
      const failed = results.find((r) => r.status === 'failed');
      const error = failed ? (failed.error ?? 'the e-mail provider refused it').slice(0, 500) : null;
      for (const r of results)
        if (r.status === 'failed') logger.warn({ artifact: key.artifactId, user: r.userId, error: r.error }, 'rollout e-mail failed');
      const now = new Date();
      await tx
        .update(schema.experienceRolloutPauses)
        .set({
          notifyingAt: null,
          notifiedAt: error ? null : now,
          notifyError: error,
          notifyAfter: error && attempt < NOTIFY_MAX_ATTEMPTS ? new Date(now.getTime() + notifyBackoffMs(attempt)) : null,
        })
        .where(
          and(
            eq(schema.experienceRolloutPauses.workspaceId, key.workspaceId),
            eq(schema.experienceRolloutPauses.artifactId, key.artifactId),
            eq(schema.experienceRolloutPauses.pausedAt, key.pausedAt),
          ),
        );
      return error ? ('failed' as const) : ('sent' as const);
    });
  } catch (err) {
    // Sending errored and the send transaction rolled back; keep the pause owed, with a backoff.
    logger.warn({ err, artifact: key.artifactId }, 'rollout e-mail could not be sent');
    await recordFailure((err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'send failed');
    return 'failed';
  }
}

/**
 * Everything still owed a pause e-mail: the one committed this round, or one a restart interrupted.
 * A claimed or backed-off row is skipped here; the claim itself is the final arbiter under lock.
 */
async function deliverPendingPauses(deps: RolloutDeps): Promise<number> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string; artifact_id: string; paused_at: Date }>(
    `SELECT workspace_id, artifact_id, paused_at FROM experience_rollout_pauses
      WHERE notified_at IS NULL AND notify_attempts < $2
        AND (notify_after IS NULL OR notify_after <= now())
      ORDER BY paused_at LIMIT $1`,
    [MAX_PAUSES_PER_RUN, NOTIFY_MAX_ATTEMPTS],
  );
  let sent = 0;
  for (const row of rows) {
    try {
      if ((await deliverPause(deps, { workspaceId: row.workspace_id, artifactId: row.artifact_id, pausedAt: row.paused_at })) === 'sent')
        sent++;
    } catch (err) {
      logger.error({ err, workspaceId: row.workspace_id, artifactId: row.artifact_id }, 'rollout pause e-mail failed');
    }
  }
  return sent;
}

/** One sweep over every workspace with a due ramp. Tests pass a clock and an injected measure. */
export async function runExperienceRolloutsOnce(deps: RolloutDeps, now = new Date()): Promise<RolloutSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string; artifact_id: string }>(
    `SELECT workspace_id, artifact_id FROM experience_rollouts
      WHERE status = 'running' AND next_step_at IS NOT NULL AND next_step_at <= $1
      ORDER BY workspace_id, artifact_id`,
    [now],
  );
  const total: RolloutSummary = { checked: 0, advanced: 0, paused: 0, failed: 0 };
  const bumped = new Set<string>();
  for (const { workspace_id: workspaceId, artifact_id: artifactId } of rows) {
    try {
      // A transaction per ramp: one broken measure or lock cannot roll back another ramp (#474).
      const out = await deps.db.withWorkspace(workspaceId, (tx) => sweepRamp(deps, tx, workspaceId, artifactId, now));
      total.checked += out.checked;
      total.advanced += out.advanced;
      total.paused += out.paused;
      if ((out.advanced || out.paused) && !bumped.has(workspaceId)) {
        await deps.hot.bump(`experiences:${workspaceId}`);
        bumped.add(workspaceId);
      }
    } catch (err) {
      total.failed++;
      logger.error({ err, workspaceId, artifactId }, 'experience rollout step failed');
      // The ramp keeps running with a past next step time, so the next tick retries it alone.
      await recordRampError(deps, workspaceId, artifactId, err, now).catch((e) =>
        logger.error({ err: e, workspaceId, artifactId }, 'could not record the rollout error'),
      );
    }
  }
  // After every pause above has committed, deliver the owner e-mails from the durable pause rows.
  await deliverPendingPauses(deps).catch((err) => logger.error({ err }, 'rollout pause e-mails failed'));
  return total;
}

export interface RolloutOptions {
  tickMs?: number;
}

/** The scheduler job: every minute by default. */
export async function runExperienceRollouts(deps: RolloutDeps, signal: AbortSignal, opts: RolloutOptions = {}) {
  const tickMs = opts.tickMs ?? 60_000;
  logger.info('scheduler role: experience rollouts');
  while (!signal.aborted) {
    try {
      await runExperienceRolloutsOnce(deps);
    } catch (err) {
      logger.error({ err }, 'experience rollout round failed');
    }
    if (signal.aborted) break;
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
