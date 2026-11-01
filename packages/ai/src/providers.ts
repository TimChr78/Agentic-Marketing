import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type AiUse, type Db, schema, type Tx } from '@agentic-marketing/db';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';

// LLM providers with the workspace's own keys (agents-and-mcp.md §4). Two wire formats cover
// most of the market: OpenAI-compatible (OpenAI, Azure, Mistral, Ollama, vLLM, LiteLLM,
// OpenRouter…) and Anthropic-compatible. Keys are sealed with the workspace key and never
// returned; each use (journeys, copilot) has one provider.

type ProviderRow = typeof schema.aiProviders.$inferSelect;

// The SDK's compatibility warnings would end up in the logs for every call.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const Kind = z.enum(['openai-compatible', 'anthropic-compatible', 'decision']);
const Use = z.enum(['journeys', 'copilot', 'decisions']);
const Models = z.object({
  default: z.string().min(1).max(200).describe('Model id for most calls, e.g. "claude-sonnet-5-5" or "gpt-5.2"'),
  fast: z.string().min(1).max(200).optional().describe('A cheaper, faster model for prompts that ask for it'),
});
const ProviderId = z.string().regex(/^aip_[0-9a-f]{32}$/);

const Provider = z.object({
  id: z.string(),
  name: z.string(),
  kind: Kind,
  baseUrl: z.string(),
  models: Models,
  structuredOutputs: z.boolean(),
  allowPersonalData: z.boolean().describe('Decision providers only: the provider is covered by a no-retention agreement'),
  useFor: z.array(Use),
  monthlyTokenBudget: z.number().nullable(),
  region: z.string(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  usedThisMonth: z.number().describe('Input and output tokens since the start of the month (UTC)'),
});

export async function usedThisMonth(tx: Tx, providerId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<string>`coalesce(sum(${schema.aiCalls.inputTokens} + ${schema.aiCalls.outputTokens}), 0)` })
    .from(schema.aiCalls)
    .where(
      and(
        eq(schema.aiCalls.providerId, providerId),
        gte(schema.aiCalls.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`),
      ),
    );
  const [held] = await tx
    .select({ n: sql<string>`coalesce(sum(${schema.aiTokenReservations.tokens}), 0)` })
    .from(schema.aiTokenReservations)
    .where(and(eq(schema.aiTokenReservations.providerId, providerId), gte(schema.aiTokenReservations.expiresAt, sql`now()`)));
  return Number(r.n) + Number(held.n);
}

/** A rough token count for a request: ~4 characters per token, plus the most the answer may use. */
export const estimateTokens = (input: unknown, maxOutput: number) => Math.ceil(JSON.stringify(input ?? '').length / 4) + maxOutput;

/**
 * Reserves tokens for one call before it is made, in its own committed transaction and under a
 * per-provider lock, so concurrent calls see each other. Throws AiUnavailable('budget') when the
 * month's usage plus reservations would pass the budget. Release it when the call has finished.
 */
export async function reserveTokens(db: Db, workspaceId: string, providerId: string, tokens: number, ttlMs = 5 * 60_000): Promise<string> {
  return db.withWorkspace(workspaceId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget:${providerId}`}))`);
    const [row] = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
    if (
      row?.monthlyTokenBudget !== null &&
      row?.monthlyTokenBudget !== undefined &&
      (await usedThisMonth(tx, providerId)) + tokens > row.monthlyTokenBudget
    )
      throw new AiUnavailable('budget');
    const id = newId('rsv');
    await tx.insert(schema.aiTokenReservations).values({ workspaceId, id, providerId, tokens, expiresAt: new Date(Date.now() + ttlMs) });
    return id;
  });
}

export async function releaseTokens(db: Db, workspaceId: string, id: string) {
  await db.withWorkspace(workspaceId, (tx) => tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, id)));
}

const providerOut = async (tx: Tx, r: ProviderRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.baseUrl,
  models: r.models,
  structuredOutputs: r.structuredOutputs,
  allowPersonalData: r.allowPersonalData,
  useFor: r.useFor,
  monthlyTokenBudget: r.monthlyTokenBudget,
  region: r.region,
  enabled: r.enabled,
  hasApiKey: !!r.secrets,
  usedThisMonth: await usedThisMonth(tx, r.id),
});

async function sealKey(tx: Tx, workspaceId: string, kp: KeyProvider, apiKey: string | undefined) {
  if (apiKey === undefined) return {};
  const s = await sealJson(tx, workspaceId, kp, { apiKey });
  return { secrets: s.blob, secretsKeyId: s.keyId };
}

/** Each use has one provider; giving it to one takes it from the others. */
async function claimUses(tx: Tx, id: string, uses: AiUse[]) {
  if (!uses.length) return;
  for (const o of await tx.select().from(schema.aiProviders))
    if (o.id !== id && o.useFor.some((u) => uses.includes(u)))
      await tx
        .update(schema.aiProviders)
        .set({ useFor: o.useFor.filter((u) => !uses.includes(u)) })
        .where(and(eq(schema.aiProviders.workspaceId, o.workspaceId), eq(schema.aiProviders.id, o.id)));
}

export interface ReadyModel {
  providerId: string;
  modelId: string;
  model: LanguageModel;
}

/** Why no model can be used; callers take their fallback and log the reason. */
export class AiUnavailable extends Error {
  constructor(readonly reason: 'no_provider' | 'budget' | 'no_key') {
    super(
      {
        no_provider: 'no AI provider is set up for this use',
        budget: "the provider's monthly token budget is used up",
        no_key: 'the AI provider has no API key',
      }[reason],
    );
  }
}

export async function languageModel(tx: Tx, row: ProviderRow, kp: KeyProvider, tier: 'default' | 'fast'): Promise<ReadyModel> {
  if (!row.secrets || !row.secretsKeyId) throw new AiUnavailable('no_key');
  const { apiKey } = await openJson<{ apiKey: string }>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId);
  const modelId = (tier === 'fast' && row.models.fast) || row.models.default;
  const model =
    row.kind === 'anthropic-compatible'
      ? createAnthropic({ baseURL: row.baseUrl, apiKey })(modelId)
      : createOpenAICompatible({
          name: 'byok',
          baseURL: row.baseUrl,
          apiKey,
          supportsStructuredOutputs: row.structuredOutputs,
          includeUsage: true,
        })(modelId);
  return { providerId: row.id, modelId, model };
}

/** The model for a use, after checking that the provider is enabled and within its budget. */
export async function modelFor(tx: Tx, kp: KeyProvider, use: AiUse, tier: 'default' | 'fast' = 'default'): Promise<ReadyModel> {
  const rows = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.enabled, true));
  const row = rows.find((r) => r.useFor.includes(use));
  if (!row) throw new AiUnavailable('no_provider');
  if (row.monthlyTokenBudget !== null && (await usedThisMonth(tx, row.id)) >= row.monthlyTokenBudget) throw new AiUnavailable('budget');
  return languageModel(tx, row, kp, tier);
}

export const listAiProviders = defineCommand({
  name: 'aiProviders.list',
  title: 'List AI providers',
  description:
    'LLM providers set up with the workspace’s own API keys, what they are used for, and tokens used this month. Keys are never returned.',
  input: z.object({}),
  output: z.object({ providers: z.array(Provider) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx.select().from(schema.aiProviders).orderBy(schema.aiProviders.createdAt);
    return { providers: await Promise.all(rows.map((r) => providerOut(ctx.tx, r))) };
  },
});

const Settings = {
  name: z.string().min(1).max(120),
  kind: Kind,
  baseUrl: z.url().max(500).describe('e.g. https://api.openai.com/v1, https://api.anthropic.com/v1 or http://ollama:11434/v1'),
  models: Models,
  structuredOutputs: z
    .boolean()
    .default(true)
    .describe('OpenAI-compatible only: whether the server supports JSON-schema response formats (turn off for older local servers)'),
  allowPersonalData: z
    .boolean()
    .default(false)
    .describe(
      'Decision providers only, people only: allow personal data in states. Set it only when the provider is covered by a no-retention agreement; JEV through CommandCode has none.',
    ),
  useFor: z
    .array(Use)
    .max(3)
    .default([])
    .describe('journeys: AI steps and prompt tests; copilot: the in-app assistant; decisions: the decision provider'),
  monthlyTokenBudget: z.number().int().min(0).nullable().default(null).describe('Calls stop (and steps take their fallback) once reached'),
  region: z.string().max(120).default('').describe('Where the provider processes data, for the records of processing'),
};

export const createAiProvider = defineCommand({
  name: 'aiProviders.create',
  title: 'Add an AI provider',
  description:
    'Add an OpenAI- or Anthropic-compatible LLM provider, or a decision provider (TypeSafe JEV/System One), with your own API key.',
  input: z.object({ ...Settings, apiKey: z.string().min(1).max(4000) }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['apiKey'],
  handler: async ({ apiKey, ...input }, ctx) => {
    const id = newId('aip');
    await claimUses(ctx.tx, id, input.useFor);
    const [row] = await ctx.tx
      .insert(schema.aiProviders)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id,
        ...input,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        ...(await sealKey(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, apiKey)),
      })
      .returning();
    return providerOut(ctx.tx, row);
  },
});

export const updateAiProvider = defineCommand({
  name: 'aiProviders.update',
  title: 'Change an AI provider',
  description: 'Change settings, uses, budget or the API key.',
  input: z.object({
    id: ProviderId,
    name: Settings.name.optional(),
    baseUrl: Settings.baseUrl.optional(),
    models: Models.optional(),
    structuredOutputs: z.boolean().optional(),
    allowPersonalData: z
      .boolean()
      .optional()
      .describe('Decision providers only, people only: allow personal data in states (no-retention agreement required)'),
    useFor: z.array(Use).max(3).optional(),
    monthlyTokenBudget: z.number().int().min(0).nullable().optional(),
    region: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
    apiKey: z.string().min(1).max(4000).optional(),
  }),
  output: Provider,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['apiKey'],
  target: (i) => i.id,
  handler: async ({ id, apiKey, ...rest }, ctx) => {
    const [cur] = await ctx.tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, id));
    if (!cur) throw new AppError('not_found', `No AI provider ${id}. List them with aiProviders.list.`);
    if (rest.useFor) await claimUses(ctx.tx, id, rest.useFor);
    const [row] = await ctx.tx
      .update(schema.aiProviders)
      .set({
        ...rest,
        ...(rest.baseUrl ? { baseUrl: rest.baseUrl.replace(/\/+$/, '') } : {}),
        ...(await sealKey(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, apiKey)),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiProviders.id, id))
      .returning();
    return providerOut(ctx.tx, row);
  },
});

export const deleteAiProvider = defineCommand({
  name: 'aiProviders.delete',
  title: 'Delete an AI provider',
  description: 'Remove a provider and its key. AI steps without a provider take their fallback.',
  input: z.object({ id: ProviderId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const res = await ctx.tx.delete(schema.aiProviders).where(eq(schema.aiProviders.id, input.id)).returning({ id: schema.aiProviders.id });
    if (!res.length) throw new AppError('not_found', `No AI provider ${input.id}.`);
    return { deleted: true as const };
  },
});
