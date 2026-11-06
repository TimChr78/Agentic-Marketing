import { MEASURES } from '@agentic-marketing/analytics';
import { artifactTypes, type ExperienceDefinition, publishHooks, publishValidators } from '@agentic-marketing/artifacts';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pushEdgeBundleNow } from './edge';

// Progressive rollout for agent changes (#427, part of #102). A published experience may carry a
// ramp: start with a small share of visitors, widen on a schedule while a metric-layer guardrail
// holds, and pause (or stop at once) when it fails. Admission is a sticky hash with its own salt,
// so a visitor admitted at 5% stays admitted when the ramp reaches 25%.

const HOUR_MS = 3_600_000;

export type RolloutStatusValue = 'running' | 'paused' | 'stopped' | 'complete';

export interface RolloutDefinition {
  steps: number[];
  stepHours: number;
  guardrail?: { measure: string; maxDropPercent: number };
}

export interface RolloutStep {
  stepIndex: number;
  share: number;
  status: RolloutStatusValue;
  nextStepAt: Date | null;
}

/** The state a freshly published ramp starts in: its first step is live at once. */
export function initialRollout(def: RolloutDefinition, now: Date): RolloutStep {
  const share = def.steps[0];
  const complete = share >= 100;
  return {
    stepIndex: 0,
    share,
    status: complete ? 'complete' : 'running',
    nextStepAt: complete ? null : new Date(now.getTime() + def.stepHours * HOUR_MS),
  };
}

/** The next step, or null when the ramp is already at its last step. */
export function nextRolloutStep(current: { steps: number[]; stepIndex: number; stepHours: number }, now: Date): RolloutStep | null {
  const stepIndex = current.stepIndex + 1;
  if (stepIndex >= current.steps.length) return null;
  const share = current.steps[stepIndex];
  const complete = share >= 100;
  return {
    stepIndex,
    share,
    status: complete ? 'complete' : 'running',
    nextStepAt: complete ? null : new Date(now.getTime() + current.stepHours * HOUR_MS),
  };
}

/** Whether a guardrail reading says the ramp may widen: a drop no larger than it allows. */
export function guardrailHolds(reading: { dropPercent: number }, maxDropPercent: number) {
  return reading.dropPercent <= maxDropPercent;
}

const Guardrail = z
  .object({
    measure: z.string(),
    maxDropPercent: z.number(),
  })
  .strict();

const GuardrailReading = z
  .object({
    at: z.string(),
    measure: z.string(),
    value: z.number(),
    baseline: z.number(),
    dropPercent: z.number(),
    ok: z.boolean(),
  })
  .strict();

const RolloutStatus = z.object({
  artifactId: z.string(),
  version: z.number().int().nullable(),
  status: z.enum(['running', 'paused', 'stopped', 'complete']).nullable(),
  stepIndex: z.number().int().nullable(),
  share: z.number().int().nullable(),
  steps: z.array(z.number().int()).nullable(),
  stepHours: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  advancedAt: z.string().nullable(),
  nextStepAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  guardrail: Guardrail.nullable(),
  lastGuardrail: GuardrailReading.nullable(),
  reason: z.string().nullable(),
  /** Why the last sweep could not advance the ramp (#474); null after a successful step. */
  lastError: z.string().nullable(),
});

/** A stop also says whether its immediate edge push happened (#477), so the caller is not misled. */
const StopRolloutStatus = RolloutStatus.extend({
  edgePushed: z.boolean().describe('True when the stopped bundle was written to the edge KV before this returned'),
  edgePushReason: z.string().nullable().describe('Why the bundle was not pushed; null when edgePushed is true'),
});

type RolloutRow = typeof schema.experienceRollouts.$inferSelect;

const statusOf = (artifactId: string, row: RolloutRow | null): z.infer<typeof RolloutStatus> =>
  row
    ? {
        artifactId,
        version: row.version,
        status: row.status,
        stepIndex: row.stepIndex,
        share: row.share,
        steps: row.steps,
        stepHours: row.stepHours,
        startedAt: row.startedAt.toISOString(),
        advancedAt: row.advancedAt.toISOString(),
        nextStepAt: row.nextStepAt?.toISOString() ?? null,
        pausedAt: row.pausedAt?.toISOString() ?? null,
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
        guardrail: row.guardrail ?? null,
        lastGuardrail: row.lastGuardrail ?? null,
        reason: row.reason,
        lastError: row.lastError,
      }
    : {
        artifactId,
        version: null,
        status: null,
        stepIndex: null,
        share: null,
        steps: null,
        stepHours: null,
        startedAt: null,
        advancedAt: null,
        nextStepAt: null,
        pausedAt: null,
        stoppedAt: null,
        guardrail: null,
        lastGuardrail: null,
        reason: null,
        lastError: null,
      };

/** The edge bundle and the decision API cache must see a changed share without waiting for a publish. */
async function invalidateExperiences(ctx: CommandContext, workspaceId: string) {
  await ctx.tx.update(schema.edgeTargets).set({ bundleHash: null });
  ctx.afterCommit?.(async () => {
    await ctx.services.hot.bump(`experiences:${workspaceId}`);
  });
}

export const rolloutStatus = defineCommand({
  name: 'experiences.rolloutStatus',
  title: 'Experience rollout status',
  description:
    'The current step, share, next step time and last guardrail reading of an experience ramp. Null fields mean the experience has no ramp.',
  input: z.object({ artifactId: z.string().regex(/^exp_[0-9a-f]{32}$/, 'An experience id (exp_…)') }),
  output: RolloutStatus,
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select()
      .from(schema.experienceRollouts)
      .where(
        and(
          eq(schema.experienceRollouts.workspaceId, ctx.principal.workspaceId),
          eq(schema.experienceRollouts.artifactId, input.artifactId),
        ),
      );
    return statusOf(input.artifactId, row ?? null);
  },
});

export const stopRollout = defineCommand({
  name: 'experiences.stopRollout',
  title: 'Stop an experience ramp',
  description:
    'Stop an experience ramp: its share becomes 0 for the decision API at once, and the edge bundle is pushed with the new share before this returns, waiting up to ten seconds for a running edge sync. `edgePushed` says whether that push happened and `edgePushReason` why not; the sync tick retries a failed push. Cloudflare still has to propagate a successful write to other regions, so edge-served sites can keep the old share for up to about a minute (the worker’s isolate cache plus KV propagation, see docs/deployment/edge.md). People and agents with experience.live may stop a ramp; it stays stopped until a person resumes it with experiences.resumeRollout, and an agent republishing the experience, including through a held change that runs after its veto window, does not restart it.',
  input: z.object({
    artifactId: z.string().regex(/^exp_[0-9a-f]{32}$/, 'An experience id (exp_…)'),
    reason: z.string().min(1).max(500).describe('Why the ramp is stopped; shown in the rollout status and the agent event'),
  }),
  output: StopRolloutStatus,
  permission: 'artifacts:publish',
  effect: 'write',
  actionClass: 'experience.live',
  target: (i) => i.artifactId,
  impact: async (input) => ({
    actionClass: 'experience.live',
    reversible: true,
    summary: `Stops the rollout of experience ${input.artifactId}`,
    touches: { artifacts: [{ id: input.artifactId, type: 'experience' }] },
  }),
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [row] = await ctx.tx
      .select()
      .from(schema.experienceRollouts)
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, input.artifactId)))
      .for('update');
    if (!row) throw new AppError('not_found', `Experience ${input.artifactId} has no ramp to stop.`);
    const { db, hot, keyProvider, egress } = ctx.services;
    const pushStopped = () =>
      db && keyProvider && egress
        ? pushEdgeBundleNow({ db, hot, kp: keyProvider, egress }, ctx.tx, ws)
        : Promise.resolve({ pushed: false, reason: 'the edge sync is not configured' as string | null });
    // Repeating the stop is idempotent, but still retries the edge push if the earlier one failed.
    if (row.status === 'stopped') {
      await invalidateExperiences(ctx, ws);
      const edge = await pushStopped();
      return { ...statusOf(input.artifactId, row), edgePushed: edge.pushed, edgePushReason: edge.reason };
    }
    const now = new Date();
    const [updated] = await ctx.tx
      .update(schema.experienceRollouts)
      .set({
        share: 0,
        status: 'stopped',
        stoppedAt: now,
        pausedAt: null,
        nextStepAt: null,
        stoppedBy: ctx.principal.userId,
        stoppedByAgent: ctx.principal.type === 'agent',
        lastError: null,
        reason: input.reason,
        updatedAt: now,
        updatedBy: ctx.principal.userId,
      })
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, input.artifactId)))
      .returning();
    await invalidateExperiences(ctx, ws);
    // The stop is an emergency (#477): push from this transaction so the share just written is the
    // one that goes to KV, and wait for the sync lock rather than skipping when a sync is running.
    // The result is part of the output, so a failed push is visible instead of swallowed.
    const edge = await pushStopped();
    return { ...statusOf(input.artifactId, updated ?? row), edgePushed: edge.pushed, edgePushReason: edge.reason };
  },
});

export const resumeRollout = defineCommand({
  name: 'experiences.resumeRollout',
  title: 'Resume an experience ramp',
  description:
    'Resume a paused or stopped experience ramp from its current step, and schedule the next step again. People only: an agent may stop a ramp but not restart it.',
  input: z.object({
    artifactId: z.string().regex(/^exp_[0-9a-f]{32}$/, 'An experience id (exp_…)'),
    reason: z.string().max(500).optional().describe('Why it is resumed, kept in the rollout status'),
  }),
  output: RolloutStatus,
  permission: 'artifacts:publish',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [row] = await ctx.tx
      .select()
      .from(schema.experienceRollouts)
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, input.artifactId)))
      .for('update');
    if (!row) throw new AppError('not_found', `Experience ${input.artifactId} has no ramp to resume.`);
    if (row.status === 'running' || row.status === 'complete') return statusOf(input.artifactId, row);
    const now = new Date();
    const share = row.steps[row.stepIndex] ?? row.steps[row.steps.length - 1] ?? 0;
    const complete = share >= 100;
    const [updated] = await ctx.tx
      .update(schema.experienceRollouts)
      .set({
        share,
        status: complete ? 'complete' : 'running',
        pausedAt: null,
        stoppedAt: null,
        stoppedBy: null,
        stoppedByAgent: false,
        lastError: null,
        advancedAt: now,
        nextStepAt: complete ? null : new Date(now.getTime() + row.stepHours * HOUR_MS),
        reason: input.reason ?? null,
        updatedAt: now,
        updatedBy: ctx.principal.userId,
      })
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, input.artifactId)))
      .returning();
    await invalidateExperiences(ctx, ws);
    return statusOf(input.artifactId, updated ?? row);
  },
});

export const rolloutCommands = [rolloutStatus, stopRollout, resumeRollout] as const;

// A published experience (re)starts its ramp from the first step; an un-ramped publish clears any
// previous state so an old ramp cannot keep limiting the new version. A person's stop is the
// exception (#454): an agent republishing content or metadata must not restart a ramp a person
// stopped, and cannot clear it by publishing an un-ramped version either. Only a person's resume or
// a person's republish starts it again.
publishHooks.push(async (ctx, artifact, version) => {
  if (artifact.type !== 'experience') return;
  const [v] = await ctx.tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, artifact.workspaceId),
        eq(schema.artifactVersions.artifactId, artifact.id),
        eq(schema.artifactVersions.number, version),
      ),
    );
  if (!v) return;
  const def = artifactTypes.experience.content.parse(v.content);
  const where = and(eq(schema.experienceRollouts.workspaceId, artifact.workspaceId), eq(schema.experienceRollouts.artifactId, artifact.id));
  const [existing] = await ctx.tx.select().from(schema.experienceRollouts).where(where).for('update');
  // A held agent change publishes through the scheduler with a system user principal, so the
  // original requester travels on `onBehalfOf` (#454): the person's stop must still hold.
  const requestedByAgent = ctx.principal.type === 'agent' || ctx.onBehalfOf?.type === 'agent';
  const keptStop = existing?.status === 'stopped' && !existing.stoppedByAgent && requestedByAgent ? existing : null;
  const now = new Date();
  if (!def.rollout) {
    if (!keptStop) {
      await ctx.tx.delete(schema.experienceRollouts).where(where);
      return;
    }
    // The new version has no ramp, but the person's stop still holds: keep the row at share 0 so
    // the un-ramped version cannot serve everyone behind the stop's back.
    await ctx.tx
      .update(schema.experienceRollouts)
      .set({ version, share: 0, status: 'stopped', nextStepAt: null, pausedAt: null, lastError: null, updatedAt: now })
      .where(where);
    return;
  }
  if (keptStop) {
    await ctx.tx
      .update(schema.experienceRollouts)
      .set({
        version,
        steps: def.rollout.steps,
        stepHours: def.rollout.stepHours,
        guardrail: def.rollout.guardrail ?? null,
        stepIndex: 0,
        share: 0,
        status: 'stopped',
        nextStepAt: null,
        pausedAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(where);
    return;
  }
  const start = initialRollout(def.rollout, now);
  const values = {
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    version,
    steps: def.rollout.steps,
    stepHours: def.rollout.stepHours,
    stepIndex: start.stepIndex,
    share: start.share,
    status: start.status,
    guardrail: def.rollout.guardrail ?? null,
    lastGuardrail: null,
    startedAt: now,
    advancedAt: now,
    nextStepAt: start.nextStepAt,
    pausedAt: null,
    stoppedAt: null,
    stoppedBy: null,
    stoppedByAgent: false,
    lastError: null,
    reason: null,
    updatedAt: now,
    updatedBy: ctx.principal.userId,
  };
  await ctx.tx
    .insert(schema.experienceRollouts)
    .values(values)
    .onConflictDoUpdate({ target: [schema.experienceRollouts.workspaceId, schema.experienceRollouts.artifactId], set: values });
});

// The guardrail is a metric-layer measure; an unknown id would leave the ramp unable to judge itself.
publishValidators.set('experience', async (content) => {
  const def = content as ExperienceDefinition;
  const measure = def.rollout?.guardrail?.measure;
  if (measure && !MEASURES[measure])
    return [`rollout.guardrail.measure "${measure}" is not a metric-layer measure; use analytics.metrics.list for the available ones`];
  return [];
});
