import { type NotifyDeps, sendMemberEmails } from '@agentic-marketing/alerts';
import { MEASURES, runAnalyticsQuery } from '@agentic-marketing/analytics';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { nextRolloutStep } from '@agentic-marketing/personalize';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, lte } from 'drizzle-orm';

// The experience rollout scheduler (#427): advances a published ramp to its next step when the step
// has run its hours and the metric-layer guardrail still holds. When the guardrail fails it pauses
// at the current step and tells the workspace owners, like the guardian does for an agent. The edge
// bundle and the decision API are invalidated so the new share applies without a republish.

const HOUR_MS = 3_600_000;

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

async function notifyPaused(
  tx: Tx,
  deps: RolloutDeps,
  workspaceId: string,
  row: typeof schema.experienceRollouts.$inferSelect,
  name: string,
  reading: GuardrailReading,
  now: Date,
) {
  const members = await tx
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(schema.workspaceMembers.role, ['owner', 'admin'])));
  if (!members.length) return;
  const url = `${deps.publicUrl.replace(/\/$/, '')}/build/experiences/${encodeURIComponent(row.artifactId)}`;
  const subject = `Experience ramp paused: ${name}`;
  const text = [
    `The ramp on “${name}” was paused at ${row.share}% of visitors.`,
    '',
    `Guardrail: ${reading.measure} fell ${reading.dropPercent.toFixed(1)}% (from ${reading.baseline} to ${reading.value}); the ramp allows ${row.guardrail?.maxDropPercent ?? 0}%.`,
    `Reason: ${row.reason ?? 'guardrail failed'}`,
    '',
    `Review the experience: ${url}`,
    '',
    'The share stays where it is and does not widen until a person resumes or stops the ramp.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">
<p>The ramp on <strong>${name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</strong> was paused at ${row.share}% of visitors.</p>
<p>Guardrail: ${reading.measure} fell ${reading.dropPercent.toFixed(1)}% (from ${reading.baseline} to ${reading.value}); the ramp allows ${row.guardrail?.maxDropPercent ?? 0}%.</p>
<p><a href="${url.replaceAll('"', '&quot;')}">Review the experience</a></p>
</body></html>`;
  const results = await sendMemberEmails(
    tx,
    deps,
    workspaceId,
    members.map((m) => ({
      userId: m.userId,
      idempotencyKey: `experience-rollout:${row.artifactId}:${now.toISOString()}:${m.userId}`,
      subject,
      text,
      html,
    })),
  );
  for (const r of results)
    if (r.status === 'failed') logger.warn({ artifact: row.artifactId, user: r.userId, error: r.error }, 'rollout e-mail failed');
}

async function sweepWorkspace(deps: RolloutDeps, tx: Tx, workspaceId: string, now: Date): Promise<RolloutSummary> {
  const due = await tx
    .select({ row: schema.experienceRollouts, name: schema.artifacts.name })
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
        eq(schema.experienceRollouts.status, 'running'),
        lte(schema.experienceRollouts.nextStepAt, now),
      ),
    )
    // Serialize replicas: the loser rechecks next_step_at after the winner commits and skips the row.
    .for('update', { of: schema.experienceRollouts });
  const summary: RolloutSummary = { checked: due.length, advanced: 0, paused: 0 };
  for (const { row, name } of due) {
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
          reason,
          updatedAt: now,
          updatedBy: 'scheduler',
        })
        .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)))
        .returning();
      if (paused) await notifyPaused(tx, deps, workspaceId, paused, name, reading, now);
      summary.paused++;
      continue;
    }
    if (reading)
      await tx
        .update(schema.experienceRollouts)
        .set({ lastGuardrail: reading, updatedAt: now })
        .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
    // Without a reading the step waits: a missing baseline must not quietly widen the ramp.
    if (row.guardrail && !reading) continue;
    const next = nextRolloutStep(row, now);
    if (!next) {
      await tx
        .update(schema.experienceRollouts)
        .set({ status: 'complete', nextStepAt: null, updatedAt: now })
        .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
      continue;
    }
    await tx
      .update(schema.experienceRollouts)
      .set({
        stepIndex: next.stepIndex,
        share: next.share,
        status: next.status,
        advancedAt: now,
        nextStepAt: next.nextStepAt,
        updatedAt: now,
        updatedBy: 'scheduler',
      })
      .where(and(eq(schema.experienceRollouts.workspaceId, workspaceId), eq(schema.experienceRollouts.artifactId, row.artifactId)));
    summary.advanced++;
  }
  if (summary.advanced || summary.paused) {
    // The edge bundle carries the share; clearing the hash makes the next sync push it.
    await tx.update(schema.edgeTargets).set({ bundleHash: null });
  }
  return summary;
}

/** One sweep over every workspace with a due ramp. Tests pass a clock and an injected measure. */
export async function runExperienceRolloutsOnce(deps: RolloutDeps, now = new Date()): Promise<RolloutSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM experience_rollouts
      WHERE status = 'running' AND next_step_at IS NOT NULL AND next_step_at <= $1`,
    [now],
  );
  const total: RolloutSummary = { checked: 0, advanced: 0, paused: 0 };
  for (const { workspace_id: workspaceId } of rows) {
    try {
      const out = await deps.db.withWorkspace(workspaceId, (tx) => sweepWorkspace(deps, tx, workspaceId, now));
      total.checked += out.checked;
      total.advanced += out.advanced;
      total.paused += out.paused;
      if (out.advanced || out.paused) await deps.hot.bump(`experiences:${workspaceId}`);
    } catch (err) {
      logger.error({ err, workspaceId }, 'experience rollout round failed');
    }
  }
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
