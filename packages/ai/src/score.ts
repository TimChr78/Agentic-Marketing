import { decisionQuestions } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime, newId } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiAllowed } from './context';
import {
  assertStateAllowed,
  DecisionError,
  decisionCall,
  decisionProvider,
  nonPersonalState,
  stateHash,
  storeProfileScore,
} from './decision';
import { AiUnavailable } from './providers';

// ai.score (#194): one metered call to a decision provider. It returns typed answers, never a
// rationale, and stores a named score for a person when asked. ai.calibration compares stored
// predictions with a later event, so a score can be shown to be calibrated before it routes.

declare module '@agentic-marketing/commands' {
  interface Services {
    /** The pool itself, for the budget reservation and score storage (their own transactions). */
    db?: Db;
  }
}

const ProfileId = z.string().regex(/^prf_[0-9a-f]{32}$/);
const ProviderId = z.string().regex(/^aip_[0-9a-f]{32}$/);
const ScoreKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const Answer = z.object({
  key: z.string(),
  type: z.enum(['noul', 'choice', 'score']),
  probability: z.number().describe('Predicted probability in 0–1 (score questions: the score normalised by its levels)'),
  label: z.string().optional().describe('The chosen label of a choice question'),
  value: z.number().optional().describe('The raw score of a score question'),
  confidence: z.number().nullable().describe('How concentrated the probability is, when the provider returns it'),
  probabilities: z.record(z.string(), z.number()),
});

const appError = (err: unknown): never => {
  if (err instanceof DecisionError) {
    if (err.code === 'no_provider') throw new AppError('conflict', err.message);
    if (err.code === 'personal_data' || err.code === 'too_many_questions' || err.code === 'too_large' || err.code === 'invalid_request')
      throw new AppError('invalid_input', err.message);
    throw new AppError('conflict', err.message);
  }
  if (err instanceof AiUnavailable) throw new AppError('conflict', err.message);
  throw err;
};

/** The newest unexpired scores of a person, newest first. */
async function unexpiredScores(tx: Tx, workspaceId: string, profileId: string, key?: string) {
  return tx
    .select()
    .from(schema.profileScores)
    .where(
      and(
        eq(schema.profileScores.workspaceId, workspaceId),
        eq(schema.profileScores.profileId, profileId),
        key ? eq(schema.profileScores.key, key) : undefined,
        sql`${schema.profileScores.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(schema.profileScores.key));
}

export const score = defineCommand({
  name: 'ai.score',
  title: 'Score with a decision model',
  description:
    'Ask a decision provider typed questions about a state and get probabilities and confidence, never text: noul (yes/no probability), choice (label and probabilities) or score (number and confidence). With profileId the person’s AI consent is checked and, unless a state is given, the state is built from non-personal data only (segment ids, event counts, agent-visible non-personal traits). A state with personal data is refused unless the provider is marked allowPersonalData under a no-retention agreement. With store, the first answer is saved as a named score for the person.',
  input: z.object({
    providerId: ProviderId.optional().describe('A decision provider; default: the enabled provider used for decisions'),
    questions: decisionQuestions,
    profileId: ProfileId.optional(),
    state: z.unknown().optional().describe('The content to evaluate. Omit with profileId to build a non-personal state from the person'),
    store: z
      .object({
        key: ScoreKey.describe('The score key segments and journeys read, e.g. "conversion_propensity"'),
        ttlHours: z.number().int().min(1).max(8760).default(168).describe('How long the score stays readable (default 7 days)'),
      })
      .optional()
      .describe('Store the first answer as a named score for the person; needs profileId'),
  }),
  output: z.object({
    answer: Answer.describe('The first answer, also listed in answers'),
    answers: z.array(Answer),
    model: z.string().describe('The model id that was asked, e.g. typesafe/jev'),
    modelVersion: z.string().describe('The model version the provider answered with, e.g. jev-1.14.0'),
    callId: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
    stored: z.object({ profileId: z.string(), key: z.string(), value: z.number(), expiresAt: z.string() }).nullable(),
  }),
  permission: 'profiles:write',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    if (input.store && !input.profileId) throw new AppError('invalid_input', 'store needs profileId: a score is stored for a person.');
    if (input.profileId) {
      const consent = await aiAllowed(ctx.tx, ctx.principal.workspaceId, input.profileId);
      if (!consent.ok) throw new AppError('forbidden', `This person's data may not be processed with AI (${consent.reason}).`);
    }
    if (!ctx.services.db) throw new AppError('conflict', 'ai.score needs the database service.');
    const db = ctx.services.db;
    let provider: Awaited<ReturnType<typeof decisionProvider>>;
    try {
      provider = await decisionProvider(ctx.tx, ctx.services.keyProvider, input.providerId);
    } catch (err) {
      return appError(err);
    }
    let state = input.state;
    if (state === undefined) {
      if (!input.profileId)
        throw new AppError('invalid_input', 'Give a state, or profileId to build a non-personal state from the person.');
      state = await nonPersonalState(ctx.tx, ctx.principal.workspaceId, ctx.services.events, input.profileId).catch(appError);
      if (!state) throw new AppError('not_found', `No profile ${input.profileId}.`);
    }
    const callId = newId('aic');
    try {
      assertStateAllowed(state, provider);
    } catch (err) {
      await logCall(db, ctx.principal, callId, provider, input, state, {
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 1000) : String(err),
      });
      return appError(err);
    }
    let result: Awaited<ReturnType<typeof decisionCall>>;
    try {
      result = await decisionCall(db, ctx.principal.workspaceId, provider, state, input.questions);
    } catch (err) {
      await logCall(db, ctx.principal, callId, provider, input, state, {
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 1000) : String(err),
      });
      return appError(err);
    }
    await logCall(db, ctx.principal, callId, provider, input, state, {
      status: 'done',
      modelVersion: result.modelVersion,
      answers: result.answers,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    });
    const first = result.answers[0];
    let stored: { profileId: string; key: string; value: number; expiresAt: string } | null = null;
    if (input.store && input.profileId && first) {
      const expiresAt = await storeProfileScore(db, ctx.principal.workspaceId, {
        profileId: input.profileId,
        key: input.store.key,
        answer: first,
        model: provider.model,
        modelVersion: result.modelVersion,
        callId,
        ttlHours: input.store.ttlHours,
      });
      stored = { profileId: input.profileId, key: input.store.key, value: first.probability, expiresAt: expiresAt.toISOString() };
    }
    return {
      answer: { ...first, confidence: first.confidence ?? null },
      answers: result.answers.map((a) => ({ ...a, confidence: a.confidence ?? null })),
      model: provider.model,
      modelVersion: result.modelVersion,
      callId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      stored,
    };
  },
});

/** One ai_calls row, kind score: the state is hashed, never stored in clear. */
async function logCall(
  db: Db,
  principal: { workspaceId: string; userId: string },
  callId: string,
  provider: { providerId: string; model: string },
  input: { questions: unknown; profileId?: string },
  state: unknown,
  out: {
    status: 'done' | 'failed';
    modelVersion?: string;
    answers?: unknown;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    error?: string;
  },
) {
  await db.withWorkspace(principal.workspaceId, (tx) =>
    tx.insert(schema.aiCalls).values({
      workspaceId: principal.workspaceId,
      id: callId,
      kind: 'score',
      status: out.status,
      providerId: provider.providerId,
      model: out.modelVersion ?? provider.model,
      profileId: input.profileId ?? null,
      input: {
        stateHash: stateHash(state),
        stateTokens: Math.ceil(JSON.stringify(state ?? null).length / 4),
        questions: input.questions as Record<string, unknown>[],
      },
      output: out.answers ? { answers: out.answers } : null,
      error: out.error ?? null,
      inputTokens: out.inputTokens ?? 0,
      outputTokens: out.outputTokens ?? 0,
      latencyMs: out.latencyMs ?? null,
      principalId: principal.userId,
      finishedAt: new Date(),
    }),
  );
}

const Score = z.object({
  key: z.string(),
  value: z.number(),
  confidence: z.number().nullable(),
  probabilities: z.record(z.string(), z.number()),
  model: z.string(),
  modelVersion: z.string(),
  callId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const profileScores = defineCommand({
  name: 'profiles.scores',
  title: 'A person’s scores',
  description: 'The unexpired scores a decision model stored for a person, by key: value, confidence, probabilities and the model.',
  input: z.object({ profileId: ProfileId, key: ScoreKey.optional() }),
  output: z.object({ scores: z.array(Score) }),
  permission: 'profiles:read',
  effect: 'read',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const rows = await unexpiredScores(ctx.tx, ctx.principal.workspaceId, input.profileId, input.key);
    return {
      scores: rows.map((r) => ({
        key: r.key,
        value: r.value,
        confidence: r.confidence,
        probabilities: r.probabilities,
        model: r.model,
        modelVersion: r.modelVersion,
        callId: r.callId,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    };
  },
});

export const calibration = defineCommand({
  name: 'ai.calibration',
  title: 'Calibrate a decision score',
  description:
    'Compares stored predictions for a score key with a later event (e.g. click or conversion) within N days: a reliability table by predicted-probability bin and the Brier score. A decision model without calibration is just a random number generator with confidence.',
  input: z.object({
    scoreKey: ScoreKey,
    event: z.string().min(1).max(200).describe('The observed outcome, e.g. "Order Completed" or "Email Clicked"'),
    withinDays: z.number().int().min(1).max(90).default(14),
    from: isoDateTime('from').optional(),
    to: isoDateTime('to').optional(),
    bins: z.number().int().min(2).max(20).default(10),
    limit: z.number().int().min(1).max(50_000).default(20_000).describe('The newest predictions to calibrate'),
  }),
  output: z.object({
    scoreKey: z.string(),
    event: z.string(),
    withinDays: z.number().int(),
    predictions: z.number().int(),
    positives: z.number().int(),
    baseRate: z.number().nullable(),
    brierScore: z.number().nullable().describe('Mean squared error of the predicted probability; lower is better, 0.25 is a coin toss'),
    reliability: z.array(
      z.object({
        from: z.number(),
        to: z.number(),
        n: z.number().int(),
        predicted: z.number().nullable().describe('Mean predicted probability in the bin'),
        observed: z.number().nullable().describe('Share of people who did the event in the bin'),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const rows = await ctx.tx
      .select()
      .from(schema.profileScores)
      .where(
        and(
          eq(schema.profileScores.workspaceId, ws),
          eq(schema.profileScores.key, input.scoreKey),
          input.from ? gte(schema.profileScores.createdAt, new Date(input.from)) : undefined,
          input.to ? lte(schema.profileScores.createdAt, new Date(input.to)) : undefined,
        ),
      )
      .orderBy(sql`${schema.profileScores.createdAt} DESC`)
      .limit(input.limit);
    if (!rows.length)
      return {
        scoreKey: input.scoreKey,
        event: input.event,
        withinDays: input.withinDays,
        predictions: 0,
        positives: 0,
        baseRate: null,
        brierScore: null,
        reliability: [],
      };
    const windowMs = input.withinDays * 86_400_000;
    const from = new Date(Math.min(...rows.map((r) => r.createdAt.getTime())));
    const to = new Date(Math.max(...rows.map((r) => r.createdAt.getTime())) + windowMs);
    // One ClickHouse query for the outcome events in the whole window, then map identifiers to profiles.
    const events = await ctx.services.events.conversionEvents(ws, { names: [input.event], from, to }).catch(() => []);
    const values = [...new Set(events.flatMap((e) => [e.anonymousId, e.userId]).filter(Boolean))];
    const ids = values.length
      ? await ctx.tx
          .select({ profileId: schema.identifiers.profileId, value: schema.identifiers.value })
          .from(schema.identifiers)
          .where(
            and(
              eq(schema.identifiers.workspaceId, ws),
              inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
              inArray(schema.identifiers.value, values),
            ),
          )
      : [];
    const profileOf = new Map(ids.map((i) => [i.value, i.profileId]));
    const outcomes = new Map<string, number[]>();
    for (const e of events) {
      const profileId = profileOf.get(e.userId) ?? profileOf.get(e.anonymousId);
      if (!profileId) continue;
      outcomes.set(profileId, [...(outcomes.get(profileId) ?? []), e.timestamp]);
    }
    const bins = Array.from({ length: input.bins }, (_, i) => ({
      from: i / input.bins,
      to: (i + 1) / input.bins,
      n: 0,
      sumPredicted: 0,
      sumObserved: 0,
    }));
    let squaredError = 0;
    let positives = 0;
    for (const r of rows) {
      const predicted = Math.min(1, Math.max(0, r.value));
      const at = r.createdAt.getTime();
      const observed = (outcomes.get(r.profileId) ?? []).some((t) => t >= at && t <= at + windowMs) ? 1 : 0;
      positives += observed;
      squaredError += (predicted - observed) ** 2;
      const bin = bins[Math.min(input.bins - 1, Math.max(0, Math.floor(predicted * input.bins)))];
      bin.n += 1;
      bin.sumPredicted += predicted;
      bin.sumObserved += observed;
    }
    return {
      scoreKey: input.scoreKey,
      event: input.event,
      withinDays: input.withinDays,
      predictions: rows.length,
      positives,
      baseRate: rows.length ? positives / rows.length : null,
      brierScore: squaredError / rows.length,
      reliability: bins.map((b) => ({
        from: b.from,
        to: b.to,
        n: b.n,
        predicted: b.n ? b.sumPredicted / b.n : null,
        observed: b.n ? b.sumObserved / b.n : null,
      })),
    };
  },
});
