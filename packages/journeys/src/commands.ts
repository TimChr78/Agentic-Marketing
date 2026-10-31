import {
  analyseHoldout,
  artifactTypes,
  DEFAULT_PURPOSES,
  type JourneyDefinition,
  publishedSingleton,
  publishValidators,
} from '@agentic-marketing/artifacts';
import { campaignWithControlForMember } from '@agentic-marketing/campaigns';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime, newId, newUuid } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { checkPushRecipient, checkRecipient, checkSmsRecipient } from '@agentic-marketing/email';
import type { JourneyEvent } from '@agentic-marketing/events';
import { consentStateOf, purposeAllowed } from '@agentic-marketing/profiles';
import { contextFor, durationSeconds, evaluate, publishedSegments } from '@agentic-marketing/segments';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { matchesCondition } from './conditions';
import { countSegmentMembers, enrollmentJobOut, enrollmentJobOutput, enrollmentJobStatus } from './enrollment';
import { duplicateEntryKey, resolveEntryKey } from './entry';
import { compile, unsupported } from './graph';
import { assignHoldout, computeJourneyHoldout, holdoutDetail, holdoutHashVersion } from './holdout';
import { conditionSegments, journeyTouches } from './impact';
import { advance, type ParticipantState } from './interpreter';

const JourneyId = z.string().regex(/^jrn_[0-9a-f]{32}$/);
const SegmentId = z.string().regex(/^seg_[0-9a-f]{32}$/);
const EnrollmentJobId = z.string().regex(/^job_[0-9a-f]{32}$/);

/** Extra publish checks other packages add (e.g. that connections and their actions exist). */
export const journeyChecks: ((def: JourneyDefinition, tx: Tx) => Promise<string[]>)[] = [];

/** Journeys can be published only with runnable nodes and published templates and segments. */
publishValidators.set('journey', async (content, tx, artifact) => {
  const def = content as JourneyDefinition;
  const problems = unsupported(def);
  for (const check of journeyChecks) problems.push(...(await check(def, tx)));
  // A changed percentage is a new scope. Refuse it once people are assigned unless the content
  // explicitly starts a new scope; assignments under the old version stay, so the result never
  // mixes two randomisations. A percentage that already has assignments is an established scope
  // and can be re-published (even after a reset to a newer one).
  if (def.controlGroup && artifact && !def.controlGroup.reset) {
    const hashVersion = holdoutHashVersion(def.controlGroup.percent);
    const scope = and(
      eq(schema.holdoutAssignments.workspaceId, artifact.workspaceId),
      eq(schema.holdoutAssignments.scopeType, 'journey'),
      eq(schema.holdoutAssignments.scopeId, artifact.id),
    );
    const [any] = await tx
      .select({ hashVersion: schema.holdoutAssignments.hashVersion })
      .from(schema.holdoutAssignments)
      .where(scope)
      .limit(1);
    if (any) {
      const [current] = await tx
        .select({ hashVersion: schema.holdoutAssignments.hashVersion })
        .from(schema.holdoutAssignments)
        .where(and(scope, eq(schema.holdoutAssignments.hashVersion, hashVersion)))
        .limit(1);
      if (!current)
        problems.push(
          'The control group percentage changed after people were assigned. Set controlGroup.reset: true to start a new scope; people already assigned keep their old arm, and reports count only the new scope.',
        );
    }
  }
  // One scope only: a campaign's control group already covers this journey as a sending member,
  // so a second randomisation here would split people differently inside the same campaign.
  if (def.controlGroup && artifact) {
    const campaign = await campaignWithControlForMember(tx, artifact.id);
    if (campaign)
      problems.push(
        `This journey defines a controlGroup, but it is a sending member of the published campaign “${campaign.name}” (${campaign.id}), which has one. Use only one scope: remove the journey’s controlGroup (it inherits the campaign’s) or the campaign’s.`,
      );
  }
  const templates = def.nodes
    .filter((n) => n.kind === 'email' || n.kind === 'sms' || n.kind === 'push')
    .map((n) => String(n.config.template));
  const segments = def.nodes.flatMap((n) => {
    if (n.kind === 'trigger') return n.config.segment ? [String(n.config.segment)] : [];
    if (n.kind === 'branch') return [...(n.config.segment ? [String(n.config.segment)] : []), ...conditionSegments(n.config.condition)];
    if (n.kind === 'waitUntil') return conditionSegments(n.config.condition);
    return [];
  });
  const prompts = def.nodes.filter((n) => n.kind === 'aiDecide' || n.kind === 'aiGenerate');
  for (const n of prompts) {
    const [row] = await tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
        ),
      )
      .where(and(eq(schema.artifacts.id, String(n.config.prompt)), eq(schema.artifacts.type, 'prompt')));
    const prompt = row?.content as { kind: string; options: { key: string }[] } | undefined;
    const want = n.kind === 'aiDecide' ? 'decide' : 'generate';
    if (!prompt) problems.push(`node "${n.id}": ${n.config.prompt} is not a published prompt`);
    else if (prompt.kind !== want) problems.push(`node "${n.id}" needs a ${want} prompt, ${n.config.prompt} is a ${prompt.kind} prompt`);
    else if (n.kind === 'aiDecide') {
      const keys = prompt.options.map((o) => o.key).sort();
      const options = [...((n.config.options as string[] | undefined) ?? [])].sort();
      if (keys.join() !== options.join())
        problems.push(`node "${n.id}": options (${options.join(', ')}) must be the prompt's options (${keys.join(', ')})`);
    }
  }
  const refs = [...templates, ...segments];
  if (refs.length) {
    const found = await tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(and(inArray(schema.artifacts.id, refs), isNotNull(schema.artifacts.publishedVersion)));
    const ok = new Set(found.map((f) => f.id));
    for (const r of new Set(refs))
      if (!ok.has(r))
        problems.push(
          `${r} is not a published ${r.startsWith('eml_') ? 'e-mail template' : r.startsWith('sms_') ? 'SMS template' : r.startsWith('psh_') ? 'push template' : 'segment'}`,
        );
  }
  return problems;
});

async function loadDefinition(tx: Tx, id: string, version?: number) {
  const [v] = await tx
    .select({ number: schema.artifactVersions.number, content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, id), version ? eq(schema.artifactVersions.number, version) : undefined))
    .orderBy(desc(schema.artifactVersions.number))
    .limit(1);
  if (!v) throw new AppError('not_found', `No journey ${id}${version ? ` version ${version}` : ''}.`);
  return { version: v.number, def: artifactTypes.journey.content.parse(v.content) as JourneyDefinition };
}

export const journeyStats = defineCommand({
  name: 'journeys.stats',
  title: 'Journey statistics',
  description:
    'How many people are where in a journey right now, and how many reached each node, converted, completed or exited. Also counts entries suppressed by a duplicate business key and by a missing entry-key property.',
  input: z.object({ artifactId: JourneyId }),
  output: z.object({
    now: z.object({
      ready: z.number(),
      waiting: z.number(),
      completed: z.number(),
      exited: z.number(),
      failed: z.number(),
      converted: z.number(),
    }),
    waitingAt: z.record(z.string(), z.number()).describe('Node id → people waiting there'),
    reached: z.record(z.string(), z.number()).describe('Node id → people who passed it'),
    duplicatesSkipped: z.number().int().describe('Entries a repeated business key suppressed'),
    missingKeySkipped: z.number().int().describe('Entries skipped because the entry-key property was missing'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({
        status: schema.journeyParticipants.status,
        node: schema.journeyParticipants.node,
        converted: schema.journeyParticipants.converted,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.journeyParticipants)
      .where(eq(schema.journeyParticipants.journeyId, input.artifactId))
      .groupBy(schema.journeyParticipants.status, schema.journeyParticipants.node, schema.journeyParticipants.converted);
    const now = { ready: 0, waiting: 0, completed: 0, exited: 0, failed: 0, converted: 0 };
    const waitingAt: Record<string, number> = {};
    for (const r of rows) {
      now[r.status] += r.n;
      if (r.converted) now.converted += r.n;
      if (r.status === 'waiting') waitingAt[r.node] = (waitingAt[r.node] ?? 0) + r.n;
    }
    const reached: Record<string, number> = {};
    for (const c of await ctx.services.events.journeyCounts(ctx.principal.workspaceId, input.artifactId))
      if (c.type === 'step' || c.type === 'resumed') reached[c.node] = Math.max(reached[c.node] ?? 0, c.count);
    const [skips] = await ctx.tx.select().from(schema.journeyEntrySkips).where(eq(schema.journeyEntrySkips.journeyId, input.artifactId));
    return { now, waitingAt, reached, duplicatesSkipped: skips?.duplicatesSkipped ?? 0, missingKeySkipped: skips?.missingKeySkipped ?? 0 };
  },
});

export const journeyHoldoutResult = defineCommand({
  name: 'journeys.holdoutResult',
  title: 'Journey uplift against its control group',
  description:
    "Per arm (control, treatment): people assigned, goal conversions, conversion rate and e-mail unsubscribes. Reports absolute and relative lift, Newcombe's 95% interval for the difference of proportions, whether the minimum sample size is met in both arms, and a verdict. Verdicts other than not_enough_data need both samples and an interval that excludes zero.",
  input: z.object({
    journeyId: JourneyId,
    from: isoDateTime('from').optional().describe('Count assignments and goal events at or after this time'),
    to: isoDateTime('to').optional().describe('Count assignments and goal events at or before this time'),
  }),
  output: z.object({
    journeyId: z.string(),
    controlGroup: z
      .object({ percent: z.number(), minSampleSize: z.number(), hashVersion: z.string() })
      .describe('The live scope and its hash version'),
    from: z.string().nullable(),
    to: z.string().nullable(),
    control: z.object({
      entered: z.number().int(),
      converted: z.number().int(),
      unsubscribed: z.number().int().describe('E-mail unsubscribes, the guardrail'),
      conversionRate: z.number(),
      unsubscribeRate: z.number(),
    }),
    treatment: z.object({
      entered: z.number().int(),
      converted: z.number().int(),
      unsubscribed: z.number().int().describe('E-mail unsubscribes, the guardrail'),
      conversionRate: z.number(),
      unsubscribeRate: z.number(),
    }),
    absoluteLift: z.number().describe('Treatment conversion rate minus control'),
    relativeLift: z.number().nullable().describe('Absolute lift divided by the control rate; null when control never converted'),
    ci95: z.tuple([z.number(), z.number()]).nullable().describe("Newcombe's 95% interval for the difference of proportions"),
    minSampleSizeMet: z.boolean(),
    verdict: z.enum(['not_enough_data', 'no_clear_difference', 'treatment_better', 'treatment_worse']),
    note: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.journeyId,
  handler: async (input, ctx) =>
    computeJourneyHoldout({ tx: ctx.tx, events: ctx.services.events, workspaceId: ctx.principal.workspaceId }, input.journeyId, {
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    }),
});

const ArmOut = z.object({
  arm: z.number().int().describe('0-based: arm 0 is the split’s first edge (variant 1)'),
  weight: z.number(),
  entered: z.number().int().describe('Participants who took this arm'),
  converted: z.number().int(),
  unsubscribed: z.number().int(),
  conversionRate: z.number(),
  unsubscribeRate: z.number(),
});

export const journeySplitResult = defineCommand({
  name: 'journeys.splitResult',
  title: 'Results per arm of a journey split',
  description:
    "For a split node in a published journey: how many people took each arm, their goal conversions and e-mail unsubscribes, and each arm compared with the first (variant 1) — absolute and relative lift, Newcombe's 95% interval and a verdict that needs the minimum sample in both arms and an interval excluding zero. The lifecycle optimiser uses it to promote or retire a variant (#313).",
  input: z.object({
    journeyId: JourneyId,
    node: z.string().min(1).describe('The split node id'),
    from: isoDateTime('from').optional(),
    to: isoDateTime('to').optional(),
    minSampleSize: z.number().int().min(1).default(200).describe('Both arms of a comparison need at least this many people'),
  }),
  output: z.object({
    journeyId: z.string(),
    node: z.string(),
    arms: z.array(ArmOut),
    comparisons: z.array(
      z.object({
        arm: z.number().int(),
        versus: z.literal(0),
        absoluteLift: z.number(),
        relativeLift: z.number().nullable(),
        ci95: z.tuple([z.number(), z.number()]).nullable(),
        minSampleSizeMet: z.boolean(),
        verdict: z.enum(['not_enough_data', 'no_clear_difference', 'treatment_better', 'treatment_worse']),
      }),
    ),
    note: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.journeyId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx
      .select({ publishedVersion: schema.artifacts.publishedVersion, type: schema.artifacts.type })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, input.journeyId));
    if (a?.type !== 'journey') throw new AppError('not_found', `No journey ${input.journeyId}.`);
    if (!a.publishedVersion) throw new AppError('not_found', `Journey ${input.journeyId} has no published version.`);
    const [v] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, input.journeyId), eq(schema.artifactVersions.number, a.publishedVersion)));
    const def = artifactTypes.journey.content.parse(v?.content);
    const split = def.nodes.find((n) => n.id === input.node);
    if (split?.kind !== 'split') throw new AppError('invalid_input', `Node ${input.node} is not a split in the published journey.`);
    const weights = (split.config as { weights?: number[] }).weights ?? [];
    const range = { ...(input.from ? { from: new Date(input.from) } : {}), ...(input.to ? { to: new Date(input.to) } : {}) };
    const ws = ctx.principal.workspaceId;
    const taken = await ctx.services.events.journeySplitArms(ws, { journeyId: input.journeyId, node: input.node, ...range });
    // Goal conversions and unsubscribes per person, as journeys.holdoutResult counts them.
    const outcomes = await ctx.services.events.journeyHoldoutOutcomes(ws, { journeyId: input.journeyId, ...range });
    const converted = new Set(outcomes.converted);
    const unsubscribed = new Set(outcomes.unsubscribed);
    const counts = weights.map(() => ({ entered: 0, converted: 0, unsubscribed: 0 }));
    for (const t of taken) {
      const c = counts[t.arm];
      if (!c) continue;
      c.entered++;
      if (converted.has(t.profileId)) c.converted++;
      if (unsubscribed.has(t.profileId)) c.unsubscribed++;
    }
    const rate = (n: number, of: number) => (of ? n / of : 0);
    const arms = counts.map((c, i) => ({
      arm: i,
      weight: weights[i],
      ...c,
      conversionRate: rate(c.converted, c.entered),
      unsubscribeRate: rate(c.unsubscribed, c.entered),
    }));
    const comparisons = counts.slice(1).map((c, i) => {
      const r = analyseHoldout(counts[0], c, input.minSampleSize);
      return {
        arm: i + 1,
        versus: 0 as const,
        absoluteLift: r.absoluteLift,
        relativeLift: r.relativeLift,
        ci95: r.ci95,
        minSampleSizeMet: r.minSampleSizeMet,
        verdict: r.verdict,
      };
    });
    const better = comparisons.filter((c) => c.verdict === 'treatment_better').map((c) => `arm ${c.arm}`);
    const note = !taken.length
      ? 'Nobody has reached this split yet.'
      : better.length
        ? `${better.join(', ')} converts better than arm 0 with a 95% interval above zero.`
        : comparisons.every((c) => c.verdict === 'not_enough_data')
          ? `Not enough people yet: each arm needs ${input.minSampleSize}.`
          : 'No arm is clearly better than arm 0 yet.';
    return { journeyId: input.journeyId, node: input.node, arms, comparisons, note };
  },
});

export const enrollProfiles = defineCommand({
  name: 'journeys.enroll',
  title: 'Put people into a journey',
  description:
    'Enter people into a published journey directly (an API or agent trigger), regardless of its trigger. Re-entry rules still apply.',
  input: z.object({
    artifactId: JourneyId,
    profileIds: z
      .array(z.string().regex(/^prf_[0-9a-f]{32}$/))
      .min(1)
      .max(1000),
    reason: z.string().max(200).optional(),
  }),
  output: z.object({ entered: z.number().int(), skipped: z.number().int() }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'journey.live',
  impact: async (input, ctx) => {
    const people = new Set(input.profileIds).size;
    const touches = await journeyTouches(ctx.tx, input.artifactId);
    return { people, summary: `enrol ${people} people`, ...(touches ? { touches } : {}) };
  },
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, input.artifactId));
    if (!a?.publishedVersion) throw new AppError('not_found', `Journey ${input.artifactId} has no published version.`);
    const { def } = await loadDefinition(ctx.tx, a.id, a.publishedVersion);
    const g = compile(def);
    let entered = 0;
    const holdout: JourneyEvent[] = [];
    for (const profileId of input.profileIds) {
      if (g.trigger.reentry !== 'always') {
        const [prior] = await ctx.tx
          .select({ id: schema.journeyParticipants.id })
          .from(schema.journeyParticipants)
          .where(
            and(
              eq(schema.journeyParticipants.journeyId, a.id),
              eq(schema.journeyParticipants.profileId, profileId),
              g.trigger.reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
            ),
          )
          .limit(1);
        if (prior) continue;
      }
      const [p] = await ctx.tx.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.id, profileId));
      if (!p) continue;
      const campaign = await campaignWithControlForMember(ctx.tx, a.id);
      const assigned = campaign
        ? await assignHoldout(
            ctx.tx,
            ctx.principal.workspaceId,
            { type: 'campaign', id: campaign.id },
            campaign.content.controlGroup,
            profileId,
          )
        : await assignHoldout(ctx.tx, ctx.principal.workspaceId, { type: 'journey', id: a.id }, g.controlGroup, profileId);
      const [participant] = await ctx.tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ctx.principal.workspaceId,
          journeyId: a.id,
          version: a.publishedVersion,
          profileId,
          entryKey: `manual:${newUuid()}`,
          node: g.start,
          status: 'ready',
          dueAt: new Date(),
          context: {
            event: { name: 'manual', properties: { reason: input.reason ?? '' } },
            ...(assigned
              ? {
                  holdout: {
                    ...assigned.assignment,
                    scope: campaign ? 'campaign' : 'journey',
                    ...(campaign ? { campaignId: campaign.id } : {}),
                  },
                }
              : {}),
          },
        })
        .returning({ id: schema.journeyParticipants.id });
      entered++;
      if (assigned?.created && participant)
        holdout.push({
          workspaceId: ctx.principal.workspaceId,
          journeyId: campaign?.id ?? a.id,
          version: campaign?.version ?? a.publishedVersion,
          participantId: participant.id,
          profileId,
          node: g.start,
          type: 'holdout_assigned',
          seq: 0,
          at: new Date().toISOString(),
          detail: holdoutDetail(assigned.assignment, campaign?.id),
        });
    }
    if (holdout.length) ctx.afterCommit?.(() => ctx.services.events.insertJourneyEvents(holdout).catch(() => {}));
    return { entered, skipped: input.profileIds.length - entered };
  },
});

/**
 * Bulk enrollment (#148): a segment backfill that runs in chunks in the scheduler, with a visible
 * job and a resumable cursor. The impact is the segment's people capped by `limit`, so the audience
 * threshold and a mandate's scope decide for agents exactly as they do for journeys.enroll; over the
 * threshold the call is refused (not approvable) and says why.
 */
export const enrollSegment = defineCommand({
  name: 'journeys.enrollSegment',
  title: 'Enroll a segment into a journey',
  description:
    'Enroll the current members of a published segment into a published journey, in chunks of 500, and return a job id. Re-entry rules, consent and suppression are checked for each person; people who cannot enter are counted with a reason. The job is resumable and the same idempotency key returns the same job. Use limit to cap how many members it tries.',
  input: z.object({
    artifactId: JourneyId,
    segmentId: SegmentId,
    limit: z.number().int().min(1).max(100_000).optional().describe('Try at most this many members; default: the whole segment'),
    reason: z.string().min(1).max(200).describe('Why this backfill runs; kept on the job and in the audit log'),
    idempotencyKey: z.string().min(1).max(200).optional().describe('The same key returns the same job instead of starting another'),
  }),
  output: z.object({
    jobId: z.string(),
    status: enrollmentJobStatus,
    people: z.number().int().describe('People the job may enroll (the segment, capped by limit)'),
    duplicate: z.boolean().describe('True when an idempotency key returned an existing job'),
  }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'journey.live',
  impact: async (input, ctx) => {
    const touches = await journeyTouches(ctx.tx, input.artifactId);
    const people = await countSegmentMembers(ctx.tx, input.segmentId, input.limit);
    return {
      people,
      summary: `enrol ${people} people from segment ${input.segmentId}`,
      touches: {
        segments: [...new Set([...(touches?.segments ?? []), input.segmentId])],
        purposes: touches?.purposes ?? [],
        topics: touches?.topics ?? [],
        channels: touches?.channels ?? [],
        artifacts: touches?.artifacts ?? [],
      },
    };
  },
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const segments = await publishedSegments(ctx.tx);
    if (!segments.some((s) => s.id === input.segmentId))
      throw new AppError('not_found', `Segment ${input.segmentId} has no published version.`);
    const [journey] = await ctx.tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, input.artifactId));
    if (journey?.type !== 'journey' || !journey.publishedVersion)
      throw new AppError('not_found', `Journey ${input.artifactId} has no published version.`);

    const requestedBy = {
      type: ctx.principal.type,
      id: ctx.principal.type === 'agent' ? (ctx.principal.agent?.id ?? ctx.principal.userId) : ctx.principal.userId,
    };
    if (input.idempotencyKey) {
      const [existing] = await ctx.tx
        .select()
        .from(schema.enrollmentJobs)
        .where(and(eq(schema.enrollmentJobs.workspaceId, ws), eq(schema.enrollmentJobs.idempotencyKey, input.idempotencyKey)));
      if (existing) {
        if (existing.journeyId !== input.artifactId || existing.segmentId !== input.segmentId)
          throw new AppError('conflict', 'This idempotency key was already used for a different enrollment. Use a new key.');
        return { jobId: existing.id, status: existing.status, people: existing.people, duplicate: true };
      }
    }

    const people = await countSegmentMembers(ctx.tx, input.segmentId, input.limit);
    const [created] = await ctx.tx
      .insert(schema.enrollmentJobs)
      .values({
        workspaceId: ws,
        id: newId('job'),
        journeyId: input.artifactId,
        segmentId: input.segmentId,
        status: 'queued',
        limit: input.limit ?? null,
        people,
        requestedByType: requestedBy.type,
        requestedById: requestedBy.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // A concurrent call with the same key won the unique index: return its job.
      const [existing] = await ctx.tx
        .select()
        .from(schema.enrollmentJobs)
        .where(and(eq(schema.enrollmentJobs.workspaceId, ws), eq(schema.enrollmentJobs.idempotencyKey, input.idempotencyKey ?? '')));
      if (!existing) throw new AppError('conflict', 'This enrollment could not be created. Try again.');
      return { jobId: existing.id, status: existing.status, people: existing.people, duplicate: true };
    }
    return { jobId: created.id, status: created.status, people: created.people, duplicate: false };
  },
});

export const enrollmentJob = defineCommand({
  name: 'journeys.enrollmentJob',
  title: 'One bulk enrollment job',
  description: 'Status, progress and skip reasons of one segment enrollment job.',
  input: z.object({ jobId: EnrollmentJobId }),
  output: enrollmentJobOutput,
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.jobId,
  handler: async (input, ctx) => {
    const [job] = await ctx.tx.select().from(schema.enrollmentJobs).where(eq(schema.enrollmentJobs.id, input.jobId));
    if (!job) throw new AppError('not_found', `No enrollment job ${input.jobId}.`);
    return enrollmentJobOut(job);
  },
});

export const enrollmentJobs = defineCommand({
  name: 'journeys.enrollmentJobs',
  title: 'Bulk enrollment jobs',
  description: 'Segment enrollment jobs of a journey or the whole workspace, newest first, with progress and skip reasons.',
  input: z.object({
    journeyId: JourneyId.optional(),
    status: enrollmentJobStatus.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ jobs: z.array(enrollmentJobOutput) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.enrollmentJobs)
      .where(
        and(
          input.journeyId ? eq(schema.enrollmentJobs.journeyId, input.journeyId) : undefined,
          input.status ? eq(schema.enrollmentJobs.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(schema.enrollmentJobs.createdAt))
      .limit(input.limit);
    return { jobs: rows.map(enrollmentJobOut) };
  },
});

export const cancelEnrollment = defineCommand({
  name: 'journeys.cancelEnrollment',
  title: 'Cancel a bulk enrollment job',
  description:
    'Stop a queued or running segment enrollment job. People already enrolled stay in the journey; the job records where it stopped.',
  input: z.object({ jobId: EnrollmentJobId, reason: z.string().max(200).optional() }),
  output: enrollmentJobOutput,
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'journey.live',
  impact: async (input, ctx) => {
    const [job] = await ctx.tx.select().from(schema.enrollmentJobs).where(eq(schema.enrollmentJobs.id, input.jobId));
    const touches = job ? await journeyTouches(ctx.tx, job.journeyId) : undefined;
    return {
      people: 0,
      summary: `cancel enrollment job ${input.jobId}`,
      ...(job
        ? {
            touches: {
              segments: [...new Set([...(touches?.segments ?? []), job.segmentId])],
              purposes: touches?.purposes ?? [],
              topics: touches?.topics ?? [],
              channels: touches?.channels ?? [],
              artifacts: touches?.artifacts ?? [],
            },
          }
        : {}),
    };
  },
  target: (i) => i.jobId,
  handler: async (input, ctx) => {
    const [job] = await ctx.tx.select().from(schema.enrollmentJobs).where(eq(schema.enrollmentJobs.id, input.jobId));
    if (!job) throw new AppError('not_found', `No enrollment job ${input.jobId}.`);
    if (job.status !== 'queued' && job.status !== 'running')
      throw new AppError('conflict', `Enrollment job ${input.jobId} is ${job.status}; only a queued or running job can be cancelled.`);
    const now = new Date();
    const [updated] = await ctx.tx
      .update(schema.enrollmentJobs)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(eq(schema.enrollmentJobs.id, input.jobId))
      .returning();
    return enrollmentJobOut(updated);
  },
});

export const simulateJourney = defineCommand({
  name: 'journeys.simulate',
  title: 'Simulate a journey',
  description:
    'Walk through a journey version (default: latest) on a virtual clock, without sending anything. With a profile, e-mail steps say whether the gateway would send or why not, and branches use the person’s data. `events` lets you script what the person does (e.g. clicks after 1 day). `sampleEvent` resolves the trigger entry key and says whether that entry would be suppressed as a duplicate.',
  input: z.object({
    artifactId: JourneyId,
    version: z.number().int().min(1).optional(),
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
    events: z
      .array(z.object({ event: z.string(), after: z.string().describe('ISO duration after entry, e.g. "P1D"') }))
      .max(50)
      .default([]),
    sampleEvent: z
      .object({
        name: z.string().min(1).max(200).optional().describe('Defaults to the trigger event'),
        messageId: z.string().min(1).max(500).optional(),
        properties: z.record(z.string(), z.unknown()).default({}),
      })
      .optional()
      .describe('An event to resolve the trigger entry key against, without sending it'),
    branches: z
      .record(z.string(), z.enum(['yes', 'no']))
      .default({})
      .describe('Answers for branch nodes when there is no profile (default no)'),
    actions: z
      .record(z.string(), z.enum(['ok', 'error']))
      .default({})
      .describe('Outcomes of action nodes, by node id (default ok). The simulation never calls them.'),
    ai: z
      .record(z.string(), z.string())
      .default({})
      .describe('Options AI decision nodes take, by node id (default: their fallback). The simulation never calls a model.'),
    maxDays: z.number().int().min(1).max(365).default(90),
  }),
  output: z.object({
    version: z.number().int(),
    outcome: z.enum(['completed', 'exited', 'waiting']),
    converted: z.boolean(),
    steps: z.array(z.object({ after: z.string(), node: z.string(), label: z.string(), kind: z.string(), detail: z.string() })),
    entry: z
      .object({
        key: z.string().nullable(),
        source: z.enum(['message_id', 'event_property']),
        duplicate: z.boolean(),
        note: z.string(),
      })
      .optional()
      .describe('The entry key a sample event resolves to, and whether it would be suppressed'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { version, def } = await loadDefinition(ctx.tx, input.artifactId, input.version);
    let graph: ReturnType<typeof compile>;
    try {
      graph = compile(def);
    } catch (e) {
      throw new AppError('invalid_input', `This journey cannot run: ${(e as Error).message}`);
    }
    const ws = ctx.principal.workspaceId;
    const start = new Date('2026-01-01T09:00:00Z');
    const scripted = input.events
      .map((e) => ({ event: e.event, at: start.getTime() + durationSeconds(e.after) * 1000 }))
      .sort((a, b) => a.at - b.at);
    const segments = input.profileId ? await publishedSegments(ctx.tx) : [];
    let entry: { key: string | null; source: 'message_id' | 'event_property'; duplicate: boolean; note: string } | undefined;
    if (input.sampleEvent && graph.trigger.event) {
      const choice = resolveEntryKey(graph.trigger, {
        messageId: input.sampleEvent.messageId ?? 'simulated-message',
        properties: input.sampleEvent.properties,
      });
      if (!choice)
        entry = {
          key: null,
          source: 'event_property',
          duplicate: false,
          note: 'the key property is missing, so the entry would be skipped',
        };
      else {
        const keyed = graph.trigger.entryKey?.source === 'event_property';
        let duplicate = false;
        if (keyed) duplicate = await duplicateEntryKey(ctx.tx, input.artifactId, choice.key, graph.trigger.reentry);
        else if (graph.trigger.reentry !== 'always') {
          if (input.profileId) {
            const [prior] = await ctx.tx
              .select({ id: schema.journeyParticipants.id })
              .from(schema.journeyParticipants)
              .where(
                and(
                  eq(schema.journeyParticipants.journeyId, input.artifactId),
                  eq(schema.journeyParticipants.profileId, input.profileId),
                  graph.trigger.reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
                ),
              )
              .limit(1);
            duplicate = !!prior;
          } else duplicate = await duplicateEntryKey(ctx.tx, input.artifactId, choice.key, graph.trigger.reentry);
        }
        entry = {
          key: choice.key,
          source: choice.source,
          duplicate,
          note: duplicate ? 'a participant with this key already exists under the re-entry rule' : 'it would enter',
        };
      }
    }
    const fmt = (t: number) => {
      const m = Math.round((t - start.getTime()) / 60_000);
      return m < 60
        ? `${m}m`
        : m < 1440
          ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
          : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
    };
    const steps: { after: string; node: string; label: string; kind: string; detail: string }[] = [];
    let state: ParticipantState = {
      node: graph.start,
      status: 'ready',
      seq: 0,
      dueAt: start,
      waitingEvent: null,
      waitingUntil: null,
      matched: false,
      converted: false,
    };
    let clock = start.getTime();
    const limit = start.getTime() + input.maxDays * 86_400_000;
    while (state.status === 'ready' || state.status === 'waiting') {
      const out = await advance(graph, state, new Date(clock), {
        key: `simulation:${input.profileId ?? 'anyone'}`,
        result: (node) => (input.actions[node] === 'error' ? { ok: false, error: 'given in the simulation' } : { ok: true }),
        ai: (node) =>
          input.ai[node] ? { option: input.ai[node], rationale: 'given in the simulation' } : { fallback: 'not called in a simulation' },
        branch: async (n) => {
          if (!input.profileId) return input.branches[n.id] === 'yes';
          if (n.segment) {
            const [m] = await ctx.tx
              .select()
              .from(schema.segmentMemberships)
              .where(and(eq(schema.segmentMemberships.segmentId, n.segment), eq(schema.segmentMemberships.profileId, input.profileId)));
            return !!m;
          }
          return (await evaluate(n.condition!, contextFor(ctx.tx, ws, ctx.services.events, segments, { scope: [input.profileId] }))).has(
            input.profileId,
          );
        },
        condition: async (n) =>
          !!input.profileId && (await matchesCondition(ctx.tx, ws, ctx.services.events, segments, input.profileId, n.condition)),
      });
      const effects = new Map(out.effects.map((e) => [`${e.node}:${e.seq}`, e]));
      for (const s of out.steps) {
        const node = graph.nodes.get(s.node)!;
        let detail = s.detail || (s.type === 'converted' ? 'converted' : '');
        const eff = effects.get(`${s.node}:${s.seq}`);
        if (eff?.kind === 'email') {
          if (input.profileId) {
            const [tpl] = await ctx.tx
              .select({
                purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'`,
                topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'`,
              })
              .from(schema.artifacts)
              .innerJoin(
                schema.artifactVersions,
                and(
                  eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
                  eq(schema.artifactVersions.artifactId, schema.artifacts.id),
                  eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
                ),
              )
              .where(eq(schema.artifacts.id, eff.template));
            const v = tpl
              ? await checkRecipient(ctx.tx, ws, ctx.services.keyProvider, input.profileId, tpl.purpose, tpl.topic)
              : { ok: false as const, reason: 'not_published: the template has no published version' };
            detail = v.ok ? `would send ${eff.template}` : `would not send: ${v.reason}`;
          } else detail = `would send ${eff.template}`;
        } else if (eff?.kind === 'sms') {
          if (input.profileId) {
            const [tpl] = await ctx.tx
              .select({
                purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'`,
                topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'`,
              })
              .from(schema.artifacts)
              .innerJoin(
                schema.artifactVersions,
                and(
                  eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
                  eq(schema.artifactVersions.artifactId, schema.artifacts.id),
                  eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
                ),
              )
              .where(eq(schema.artifacts.id, eff.template));
            const v = tpl
              ? await checkSmsRecipient(ctx.tx, ws, ctx.services.keyProvider, input.profileId, tpl.purpose, tpl.topic)
              : { ok: false as const, reason: 'not_published: the template has no published version' };
            detail = v.ok ? `would text ${eff.template}` : `would not text: ${v.reason}`;
          } else detail = `would text ${eff.template}`;
        } else if (eff?.kind === 'push') {
          if (input.profileId) {
            const [tpl] = await ctx.tx
              .select({
                purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'`,
                topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'`,
              })
              .from(schema.artifacts)
              .innerJoin(
                schema.artifactVersions,
                and(
                  eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
                  eq(schema.artifactVersions.artifactId, schema.artifacts.id),
                  eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
                ),
              )
              .where(eq(schema.artifacts.id, eff.template));
            const v = tpl
              ? await checkPushRecipient(ctx.tx, ws, ctx.services.keyProvider, input.profileId, tpl.purpose, tpl.topic)
              : { ok: false as const, reason: 'not_published: the template has no published version' };
            detail = v.ok
              ? `would notify ${eff.template} (${v.devices} device${v.devices === 1 ? '' : 's'})`
              : `would not notify: ${v.reason}`;
          } else detail = `would notify ${eff.template}`;
        } else if (eff?.kind === 'updateProfile') detail = `would set ${eff.trait} = ${JSON.stringify(eff.value)}`;
        else if (eff?.kind === 'webhook') {
          const allowed =
            !input.profileId ||
            (await (async () => {
              const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
              const basis = purposes.find((x) => x.key === graph.purpose)?.basis ?? 'consent';
              const state = (await consentStateOf(ctx.tx, ws, input.profileId!)).find(
                (x) => x.purpose === graph.purpose && (x.channel === '' || x.channel === 'webhook'),
              );
              return purposeAllowed(basis, state?.status);
            })());
          detail = allowed ? `would send a webhook to ${eff.endpoint}` : `would not send: no lawful basis for purpose "${graph.purpose}"`;
        } else if (eff?.kind === 'transform') detail = `would set vars.${eff.set}`;
        else if (eff?.kind === 'ai' || eff?.kind === 'action') continue; // the outcome follows when the step resumes
        if (
          s.type === 'step' ||
          s.type === 'converted' ||
          (s.type === 'resumed' &&
            (node.kind === 'aiDecide' || node.kind === 'aiGenerate' || node.kind === 'action' || node.kind === 'waitUntil'))
        )
          steps.push({ after: fmt(clock), node: s.node, label: node.label, kind: node.kind, detail });
      }
      state = out.state;
      if (state.status !== 'waiting') break;
      // AI and action steps answer right away in a simulation.
      const at = graph.nodes.get(state.node)!;
      if (at.kind === 'aiDecide' || at.kind === 'aiGenerate' || at.kind === 'action') {
        state = { ...state, waitingEvent: null };
        continue;
      }
      // A wait-until has no data changes during a simulation: show the wait and jump to its
      // deadline instead of walking every hourly recheck.
      if (at.kind === 'waitUntil') {
        if (clock >= limit) break;
        clock = Math.min(state.waitingUntil?.getTime() ?? limit, limit);
        state = { ...state, waitingEvent: null };
        continue;
      }
      // Jump the clock to the next scripted event the person waits for, or the timer.
      const next = scripted.find((e) => e.at >= clock && e.event === state.waitingEvent && e.at <= (state.dueAt?.getTime() ?? Infinity));
      clock = next ? next.at : (state.dueAt?.getTime() ?? limit);
      if (clock > limit) break;
      state = { ...state, matched: !!next, waitingEvent: null };
      if (next) scripted.splice(scripted.indexOf(next), 1);
    }
    const outcome: 'completed' | 'exited' | 'waiting' =
      state.status === 'completed' || state.status === 'exited' ? state.status : 'waiting';
    return { version, outcome, converted: state.converted, steps, entry };
  },
});

export const migrateJourney = defineCommand({
  name: 'journeys.migrate',
  title: 'Move participants to the published version',
  description:
    'Moves people who are still in an older version of a journey onto the published one. A participant whose node exists in the new version (same id and kind) keeps its place and any wait; `mapping` moves others (old node id → new node id) and they restart that step; the rest stay on their version, or exit with unmatched="exit". Try it with dryRun first.',
  input: z.object({
    artifactId: JourneyId,
    mapping: z.record(z.string(), z.string()).default({}).describe('Old node id → node id in the published version'),
    unmatched: z.enum(['stay', 'exit']).default('stay'),
    dryRun: z.boolean().default(true),
  }),
  output: z.object({
    toVersion: z.number().int(),
    moved: z.number().int(),
    restarted: z.number().int().describe('Moved to a node of another kind: they run that step again'),
    stayed: z.number().int(),
    exited: z.number().int(),
    byNode: z.array(z.object({ fromVersion: z.number(), from: z.string(), to: z.string().nullable(), count: z.number() })),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  actionClass: 'journey.live',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, input.artifactId));
    if (a?.type !== 'journey' || !a.publishedVersion)
      throw new AppError('not_found', `Journey ${input.artifactId} has no published version.`);
    const target = compile((await loadDefinition(ctx.tx, a.id, a.publishedVersion)).def);
    for (const [from, to] of Object.entries(input.mapping))
      if (!target.nodes.has(to))
        throw new AppError('invalid_input', `mapping ${from} → ${to}: version ${a.publishedVersion} has no node "${to}".`);
    const active = await ctx.tx
      .select()
      .from(schema.journeyParticipants)
      .where(
        and(
          eq(schema.journeyParticipants.journeyId, a.id),
          inArray(schema.journeyParticipants.status, ['ready', 'waiting']),
          sql`${schema.journeyParticipants.version} <> ${a.publishedVersion}`,
        ),
      );
    const olds = new Map<number, ReturnType<typeof compile>>();
    const out = { toVersion: a.publishedVersion, moved: 0, restarted: 0, stayed: 0, exited: 0 };
    const byNode = new Map<string, { fromVersion: number; from: string; to: string | null; count: number }>();
    for (const p of active) {
      if (!olds.has(p.version)) olds.set(p.version, compile((await loadDefinition(ctx.tx, a.id, p.version)).def));
      const oldNode = olds.get(p.version)!.nodes.get(p.node);
      const to = input.mapping[p.node] ?? (target.nodes.has(p.node) ? p.node : null);
      const key = `${p.version}:${p.node}`;
      const b = byNode.get(key) ?? { fromVersion: p.version, from: p.node, to, count: 0 };
      b.count++;
      byNode.set(key, b);
      if (!to) {
        if (input.unmatched === 'exit') {
          out.exited++;
          if (!input.dryRun)
            await ctx.tx
              .update(schema.journeyParticipants)
              .set({
                status: 'exited',
                dueAt: null,
                waitingEvent: null,
                waitingUntil: null,
                error: `left in a migration to v${a.publishedVersion}`,
                updatedAt: new Date(),
              })
              .where(eq(schema.journeyParticipants.id, p.id));
        } else out.stayed++;
        continue;
      }
      // Same kind at the same place: the wait (due time, awaited event) carries over as it is.
      const same = to === p.node && oldNode?.kind === target.nodes.get(to)?.kind;
      if (same) out.moved++;
      else out.restarted++;
      if (!input.dryRun)
        await ctx.tx
          .update(schema.journeyParticipants)
          .set(
            same
              ? { version: a.publishedVersion, updatedAt: new Date() }
              : {
                  version: a.publishedVersion,
                  node: to,
                  status: 'ready',
                  dueAt: new Date(),
                  waitingEvent: null,
                  waitingUntil: null,
                  matched: false,
                  updatedAt: new Date(),
                },
          )
          .where(eq(schema.journeyParticipants.id, p.id));
    }
    return { ...out, moved: out.moved + out.restarted, byNode: [...byNode.values()] };
  },
});

export const journeyCommands = [
  journeyStats,
  journeyHoldoutResult,
  journeySplitResult,
  enrollProfiles,
  enrollSegment,
  enrollmentJob,
  enrollmentJobs,
  cancelEnrollment,
  simulateJourney,
  migrateJourney,
] as const;
