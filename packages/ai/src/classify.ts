import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiAllowed } from './context';
import { promptVersion } from './prompts';

// ai.classify: label a text (an inbound reply, a form message, a review) with one of a classify
// prompt's labels, e.g. from n8n. The model call is a job for the AI worker, never inside the
// command's transaction; ai.classification returns the outcome. With a person and the prompt's
// `trait`, the label is stored on their profile.
//
// Human review: prompts with `review.sampleRate` set aside that share of answered calls;
// ai.reviews lists them and ai.review records a person's verdict, which ai.reviews sums up per
// prompt as a quality rate.

const PromptId = z.string().regex(/^prm_[0-9a-f]{32}$/);
const CallId = z.string().regex(/^aic_[0-9a-f]{32}$/);

export const classify = defineCommand({
  name: 'ai.classify',
  title: 'Classify a text',
  description:
    'Label a text with one of a published classify prompt’s labels (e.g. the intent of an e-mail reply). Returns a callId at once; the AI worker answers within seconds: read it with ai.classification. With profileId, the person’s AI consent is checked and, if the prompt names a `trait`, the label is stored on their profile.',
  input: z.object({
    artifactId: PromptId,
    text: z.string().min(1).max(8000),
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
  }),
  output: z.object({ callId: z.string(), status: z.literal('pending') }),
  permission: 'profiles:write',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const p = await promptVersion(ctx.tx, input.artifactId);
    if (!p) throw new AppError('not_found', `${input.artifactId} is not a published prompt.`);
    if (p.def.kind !== 'classify')
      throw new AppError('invalid_input', `${input.artifactId} is a ${p.def.kind} prompt; ai.classify needs a classify prompt.`);
    if (input.profileId) {
      const consent = await aiAllowed(ctx.tx, ctx.principal.workspaceId, input.profileId);
      if (!consent.ok) throw new AppError('forbidden', `This person's data may not be processed with AI (${consent.reason}).`);
    }
    const callId = newId('aic');
    await ctx.tx.insert(schema.aiCalls).values({
      workspaceId: ctx.principal.workspaceId,
      id: callId,
      kind: 'classify',
      status: 'pending',
      promptId: input.artifactId,
      promptVersion: p.version,
      profileId: input.profileId ?? null,
      input: { text: input.text },
      principalId: ctx.principal.userId,
    });
    return { callId, status: 'pending' as const };
  },
});

export const classification = defineCommand({
  name: 'ai.classification',
  title: 'Result of a classification',
  description:
    'The outcome of an ai.classify call: the label and a rationale once the AI worker has answered (status done), or why it failed.',
  input: z.object({ callId: CallId }),
  output: z.object({
    status: z.enum(['pending', 'running', 'done', 'fallback', 'failed']),
    label: z.string().nullable(),
    rationale: z.string().nullable(),
    error: z.string().nullable(),
    traitSet: z.string().nullable().describe('The profile trait the label was stored in, if any'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [c] = await ctx.tx
      .select()
      .from(schema.aiCalls)
      .where(and(eq(schema.aiCalls.id, input.callId), eq(schema.aiCalls.kind, 'classify')));
    if (!c) throw new AppError('not_found', `No classification ${input.callId}.`);
    const out = (c.output ?? {}) as { label?: string; trait?: string };
    return { status: c.status, label: out.label ?? null, rationale: c.rationale, error: c.error, traitSet: out.trait ?? null };
  },
});

const Review = z.object({
  callId: z.string(),
  kind: z.string(),
  promptId: z.string().nullable(),
  promptVersion: z.number().nullable(),
  journeyId: z.string().nullable(),
  input: z.record(z.string(), z.unknown()).describe('What the model saw (minimised, pseudonymised)'),
  output: z.unknown(),
  rationale: z.string().nullable(),
  status: z.enum(['pending', 'reviewed']),
  verdict: z.enum(['good', 'bad']).nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const listReviews = defineCommand({
  name: 'ai.reviews',
  title: 'AI answers to review',
  description:
    'Sampled AI answers (prompts with review.sampleRate) for a person to check, newest first, and per prompt how many were reviewed and the share judged good.',
  input: z.object({
    status: z.enum(['pending', 'reviewed']).default('pending'),
    promptId: PromptId.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    reviews: z.array(Review),
    quality: z.array(
      z.object({
        promptId: z.string(),
        pending: z.number().int(),
        good: z.number().int(),
        bad: z.number().int(),
        goodRate: z.number().nullable().describe('good / (good + bad), null until something is reviewed'),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.aiCalls;
    const rows = await ctx.tx
      .select()
      .from(c)
      .where(and(eq(c.reviewStatus, input.status), input.promptId ? eq(c.promptId, input.promptId) : undefined))
      .orderBy(desc(c.createdAt))
      .limit(input.limit);
    const quality = (
      await ctx.tx.execute<{ prompt_id: string; pending: number; good: number; bad: number }>(sql`
        SELECT prompt_id, count(*) FILTER (WHERE review_status = 'pending')::int AS pending,
               count(*) FILTER (WHERE review_verdict = 'good')::int AS good, count(*) FILTER (WHERE review_verdict = 'bad')::int AS bad
        FROM ai_calls WHERE review_status IS NOT NULL AND prompt_id IS NOT NULL ${input.promptId ? sql`AND prompt_id = ${input.promptId}` : sql``}
        GROUP BY prompt_id ORDER BY prompt_id`)
    ).rows.map((q) => ({
      promptId: q.prompt_id,
      pending: q.pending,
      good: q.good,
      bad: q.bad,
      goodRate: q.good + q.bad ? q.good / (q.good + q.bad) : null,
    }));
    return {
      reviews: rows.map((r) => ({
        callId: r.id,
        kind: r.kind,
        promptId: r.promptId,
        promptVersion: r.promptVersion,
        journeyId: r.journeyId,
        input: r.input,
        output: r.output,
        rationale: r.rationale,
        status: r.reviewStatus ?? 'pending',
        verdict: r.reviewVerdict ?? null,
        note: r.reviewNote ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      quality,
    };
  },
});

export const submitReview = defineCommand({
  name: 'ai.review',
  title: 'Review an AI answer',
  description:
    'Record whether a sampled AI answer was good or bad, with a note on what was wrong. People only: reviews are the human check on the model.',
  input: z.object({ callId: CallId, verdict: z.enum(['good', 'bad']), note: z.string().max(2000).optional() }),
  output: z.object({ callId: z.string(), verdict: z.enum(['good', 'bad']) }),
  permission: 'artifacts:read',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.callId,
  handler: async (input, ctx) => {
    const done = await ctx.tx
      .update(schema.aiCalls)
      .set({
        reviewStatus: 'reviewed',
        reviewVerdict: input.verdict,
        reviewNote: input.note ?? null,
        reviewedBy: ctx.principal.userId,
        reviewedAt: new Date(),
      })
      .where(and(eq(schema.aiCalls.id, input.callId), sql`${schema.aiCalls.reviewStatus} IS NOT NULL`))
      .returning({ id: schema.aiCalls.id });
    if (!done.length) throw new AppError('not_found', `${input.callId} is not an answer sampled for review.`);
    return { callId: input.callId, verdict: input.verdict };
  },
});

export const classifyCommands = [classify, classification, listReviews, submitReview] as const;
