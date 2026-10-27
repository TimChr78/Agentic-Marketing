import { defineCommand } from '@agentic-marketing/commands';
import { isoDateTime } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { classifyCommands } from './classify';
import { copilotCommands } from './copilot';
import { listTestRuns, testPrompt, testRunResults } from './prompts';
import { createAiProvider, deleteAiProvider, listAiProviders, updateAiProvider } from './providers';

// The decision log and usage: every AI call (journey steps, prompt tests, copilot turns) with
// what the model saw, what it answered, why a fallback was taken, tokens and latency.

const Call = z.object({
  id: z.string(),
  kind: z.enum(['decide', 'generate', 'copilot', 'test', 'classify']),
  status: z.enum(['pending', 'running', 'done', 'fallback', 'failed']),
  model: z.string().nullable(),
  promptId: z.string().nullable(),
  promptVersion: z.number().nullable(),
  journeyId: z.string().nullable(),
  node: z.string().nullable(),
  profileId: z.string().nullable(),
  input: z.record(z.string(), z.unknown()).describe('The minimised context the model saw'),
  output: z.unknown(),
  rationale: z.string().nullable(),
  error: z.string().nullable().describe('Why the call failed or a fallback was taken'),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number().nullable(),
  cached: z.boolean().describe('Text served from the per-segment cache, without a model call'),
  review: z
    .object({ status: z.enum(['pending', 'reviewed']), verdict: z.enum(['good', 'bad']).nullable(), note: z.string().nullable() })
    .nullable(),
  createdAt: z.string(),
});

export const listAiCalls = defineCommand({
  name: 'ai.calls',
  title: 'AI decision log',
  description:
    'Recent AI calls, newest first: journey decisions and generated texts with their rationale, fallbacks with the reason, prompt tests and copilot turns. Filter by journey, prompt, profile or kind.',
  input: z.object({
    journeyId: z.string().optional(),
    promptId: z.string().optional(),
    profileId: z.string().optional(),
    kind: z.enum(['decide', 'generate', 'copilot', 'test', 'classify']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    before: isoDateTime('before').optional(),
  }),
  output: z.object({ calls: z.array(Call) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.aiCalls;
    const rows = await ctx.tx
      .select()
      .from(c)
      .where(
        and(
          input.journeyId ? eq(c.journeyId, input.journeyId) : undefined,
          input.promptId ? eq(c.promptId, input.promptId) : undefined,
          input.profileId ? eq(c.profileId, input.profileId) : undefined,
          input.kind ? eq(c.kind, input.kind) : undefined,
          input.before ? lt(c.createdAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(c.createdAt))
      .limit(input.limit);
    return {
      calls: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        model: r.model,
        promptId: r.promptId,
        promptVersion: r.promptVersion,
        journeyId: r.journeyId,
        node: r.node,
        profileId: r.profileId,
        input: r.input,
        output: r.output,
        rationale: r.rationale,
        error: r.error,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
        cached: r.cached,
        review: r.reviewStatus ? { status: r.reviewStatus, verdict: r.reviewVerdict ?? null, note: r.reviewNote ?? null } : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

export const aiUsage = defineCommand({
  name: 'ai.usage',
  title: 'AI usage',
  description: 'Tokens, calls and fallbacks per day and kind over the last days.',
  input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
  output: z.object({
    days: z.array(
      z.object({
        day: z.string(),
        kind: z.string(),
        calls: z.number(),
        fallbacks: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const c = schema.aiCalls;
    const day = sql<string>`to_char(date_trunc('day', ${c.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const rows = await ctx.tx
      .select({
        day,
        kind: c.kind,
        calls: sql<number>`count(*)::int`,
        fallbacks: sql<number>`count(*) FILTER (WHERE ${c.status} IN ('fallback', 'failed'))::int`,
        inputTokens: sql<number>`coalesce(sum(${c.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${c.outputTokens}), 0)::int`,
      })
      .from(c)
      .where(gte(c.createdAt, new Date(Date.now() - input.days * 86_400_000)))
      .groupBy(day, c.kind)
      .orderBy(day);
    return { days: rows };
  },
});

export const aiCommands = [
  listAiProviders,
  createAiProvider,
  updateAiProvider,
  deleteAiProvider,
  testPrompt,
  testRunResults,
  listTestRuns,
  listAiCalls,
  aiUsage,
  ...classifyCommands,
  ...copilotCommands,
] as const;
