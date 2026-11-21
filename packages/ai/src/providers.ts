import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sleep } from '@agentic-marketing/core';
import { type AiUse, type Db, schema, type Tx } from '@agentic-marketing/db';
import { checkUrl, type EgressPolicy, egressFetchStream } from '@agentic-marketing/integrations';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

// LLM providers with the workspace's own keys (agents-and-mcp.md §4). Two wire formats cover
// most of the market: OpenAI-compatible and Anthropic-compatible. The named model providers (see
// `modelProviderNames`) are a known population, so redaction's `<provider>Key` qualifier list and
// its completeness test read the same list instead of guessing (#956).

/**
 * Known model-provider names the platform documents for a workspace's own key (#956, #968 review),
 * the way users spell them in a provider name. Redaction treats `<name>Key`, `<name>Token` and
 * `<name>Secret` as credentials, and `apps/server/test/redaction-providers.test.ts` fails when one
 * of these names has no qualifier. Runtime provider names are free text, so this is coverage of
 * the names we know, not of every possible name.
 *
 * Keys are sealed with the workspace key and never returned; each use (journeys, copilot) has one
 * provider.
 */
export const modelProviderNames = [
  // Anthropic-compatible, and the original OpenAI service.
  'openai',
  'anthropic',
  'azure',
  'azureopenai',
  // OpenAI-compatible servers the docs name.
  'mistral',
  'ollama',
  'vllm',
  'litellm',
  'openrouter',
  'lmstudio',
  'groq',
  'together',
  'deepseek',
  'gemini',
  'google',
  'cohere',
  'perplexity',
  'fireworks',
  'huggingface',
  'hf',
  'replicate',
  'xai',
  // Amazon Bedrock and Google Vertex front several model families behind one key.
  'bedrock',
  'vertex',
] as const;

type ProviderRow = typeof schema.aiProviders.$inferSelect;

// The SDK's compatibility warnings would end up in the logs for every call.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const Kind = z.enum(['openai-compatible', 'anthropic-compatible', 'decision']);
/** The provider kinds this package speaks, so a test can check every one has a redaction qualifier (#898). */
export const aiProviderKinds = Kind.options;
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
  // One statement, one snapshot: settlement inserts the usage row and deletes the hold in one
  // transaction, so summing both in two statements can see neither at the moment in between (#941).
  // Usage is attributed to the month it was billed in; rows from before `billed_at` fall back to
  // their queue time. A call's first settlement fixes its billing period: later corrections and
  // later attempts of the same call keep that `billed_at` (see the coalesce in every settlement
  // write), so correcting an estimate in a later month does not move the call's whole usage.
  const { rows } = await tx.execute<{ n: string }>(sql`
    SELECT coalesce((
             SELECT sum(input_tokens + output_tokens) FROM ai_calls
             WHERE provider_id = ${providerId}
               AND coalesce(billed_at, created_at) >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           ), 0)
         + coalesce((
             SELECT sum(tokens) FROM ai_token_reservations
             WHERE provider_id = ${providerId} AND expires_at >= now() AND estimated_tokens IS NULL
           ), 0) AS n`);
  return Number(rows[0]?.n ?? 0);
}

/** Take the per-provider budget lock. Callers take it before touching a hold or its usage row. */
export const lockBudget = (tx: Tx, providerId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget:${providerId}`}))`);

/** Remove estimates a crashed attempt left past their billing deadline; they no longer count. */
const cleanupExpiredEstimates = (tx: Tx, providerId: string) =>
  tx.execute(
    sql`DELETE FROM ai_token_reservations
        WHERE provider_id = ${providerId} AND estimated_tokens IS NOT NULL AND expires_at < now()`,
  );

/** How long a live hold is kept after its own deadline, so a call that started just before it may still settle. */
export const EXPIRED_HOLD_GRACE_MS = 60 * 60_000;
/** How many expired live holds one sweep removes at most; the next tick continues. */
export const EXPIRED_HOLD_SWEEP_BATCH = 1_000;
/** How often the scheduler sweeps expired live holds. */
export const EXPIRED_HOLD_SWEEP_INTERVAL_MS = 60 * 60_000;

interface HoldSweepQuery {
  query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Delete live holds (`estimated_tokens IS NULL`) that expired more than `graceMs` ago and that no
 * `ai_calls` row still links to. A hold with a linked call belongs to `settleStaleReservation`,
 * which records the estimate before clearing it; deleting that row would lose usage the provider
 * may already have billed. An expired hold no longer counts against the monthly budget, so this
 * frees no live allowance: it only removes dead rows the decision, copilot, hosted and
 * independent-check flows leave when a process dies between reserve and settle (#1080).
 *
 * The deadline is the hold's own `expires_at`: the five-minute TTL for an ordinary call, or the
 * billing-month deadline `billingReservationTtlMs` sets before a metered call. `now()` is the
 * database clock, the same one that wrote the deadline.
 */
export async function sweepExpiredTokenReservations(
  admin: HoldSweepQuery,
  opts: { graceMs?: number; batchSize?: number } = {},
): Promise<number> {
  const graceSeconds = Math.max(0, Math.floor((opts.graceMs ?? EXPIRED_HOLD_GRACE_MS) / 1_000));
  const { rowCount } = await admin.query(
    `DELETE FROM ai_token_reservations
      WHERE ctid = ANY (ARRAY(
        SELECT r.ctid FROM ai_token_reservations r
         WHERE r.estimated_tokens IS NULL
           AND r.expires_at < now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM ai_calls c WHERE c.reservation_id = r.id)
         ORDER BY r.expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      ))`,
    [graceSeconds, opts.batchSize ?? EXPIRED_HOLD_SWEEP_BATCH],
  );
  return rowCount ?? 0;
}

export interface ExpiredHoldSweepOptions {
  graceMs?: number;
  batchSize?: number;
  tickMs?: number;
  /** Batches per tick before the sleep; the next tick continues from the remaining rows. */
  maxBatches?: number;
  log?: (message: string) => void;
  onError?: (err: unknown) => void;
}

/** The scheduler job: one pass at start, then every `tickMs`; the sleep ends early on abort. */
export async function runExpiredHoldSweep(
  deps: { db: { admin: HoldSweepQuery } },
  signal: AbortSignal,
  opts: ExpiredHoldSweepOptions = {},
): Promise<void> {
  const tickMs = opts.tickMs ?? EXPIRED_HOLD_SWEEP_INTERVAL_MS;
  const batchSize = opts.batchSize ?? EXPIRED_HOLD_SWEEP_BATCH;
  const maxBatches = opts.maxBatches ?? 10;
  while (!signal.aborted) {
    let deleted = 0;
    try {
      for (let batch = 0; batch < maxBatches && !signal.aborted; batch++) {
        const removed = await sweepExpiredTokenReservations(deps.db.admin, { graceMs: opts.graceMs, batchSize });
        deleted += removed;
        if (removed < batchSize) break;
      }
      if (deleted) opts.log?.(`expired budget holds: ${deleted} dead live hold(s) removed`);
    } catch (err) {
      opts.onError?.(err);
    }
    if (signal.aborted) return;
    await sleep(tickMs, signal);
  }
}

/** The provider a reservation belongs to; its id is immutable, so reading it before the lock is safe. */
async function reservationProvider(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ providerId: schema.aiTokenReservations.providerId })
    .from(schema.aiTokenReservations)
    .where(eq(schema.aiTokenReservations.id, id));
  return row?.providerId ?? null;
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
    await lockBudget(tx, providerId);
    await cleanupExpiredEstimates(tx, providerId);
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
  await db.withWorkspace(workspaceId, async (tx) => {
    // Same lock as reservation and settlement, so a release cannot land inside the gap of a
    // concurrent budget read. Lock order: budget lock -> hold/usage rows.
    const providerId = await reservationProvider(tx, id);
    if (!providerId) return;
    await lockBudget(tx, providerId);
    await tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, id));
  });
}

/** The tokens an error already says the provider billed, if it says. */
export function usageOfError(err: unknown, depth = 0): { inputTokens: number; outputTokens: number } | null {
  const carrier = err as {
    usage?: unknown;
    totalUsage?: unknown;
    response?: { usage?: unknown };
    cause?: unknown;
    lastError?: unknown;
  };
  const usage = carrier?.usage ?? carrier?.totalUsage ?? carrier?.response?.usage;
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    const input = u.inputTokens ?? u.promptTokens;
    const output = u.outputTokens ?? u.completionTokens;
    if (typeof input === 'number' || typeof output === 'number')
      return {
        inputTokens: typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.trunc(input)) : 0,
        outputTokens: typeof output === 'number' && Number.isFinite(output) ? Math.max(0, Math.trunc(output)) : 0,
      };
  }
  // An SDK retry wrapper keeps the failed attempt's error, which may carry the usage.
  const nested = carrier?.lastError ?? carrier?.cause;
  if (depth < 2 && nested && nested !== err) return usageOfError(nested, depth + 1);
  return null;
}

/**
 * The reserved estimate as input and output tokens. The reservation is one total; the output cap
 * is the part the request could have written, and the rest is its prompt.
 */
export const estimatedUsage = (total: number, maxOutput: number) => {
  const output = Math.max(0, Math.min(total, maxOutput));
  return { inputTokens: Math.max(0, total - output), outputTokens: output };
};

/** A reservation's id and the tokens it holds. */
export interface TokenReservation {
  id: string;
  tokens: number;
}

/**
 * Reserves at most `maxTokens` for one turn, but never more than the month's actual remaining
 * allowance, and returns the amount reserved (the hard cap for the turn). A remainder below
 * `minimumTokens` refuses the turn with AiUnavailable('budget') instead of starting one that
 * cannot produce a useful answer. The check runs under the same per-provider lock as
 * `reserveTokens`, so two turns cannot both take the last of the budget.
 */
export async function reserveUpToTokens(
  db: Db,
  workspaceId: string,
  providerId: string,
  maxTokens: number,
  minimumTokens: number,
  ttlMs = 5 * 60_000,
): Promise<TokenReservation> {
  return db.withWorkspace(workspaceId, async (tx) => {
    await lockBudget(tx, providerId);
    await cleanupExpiredEstimates(tx, providerId);
    const [row] = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
    const used = await usedThisMonth(tx, providerId);
    const budget = row?.monthlyTokenBudget;
    const remaining = budget === null || budget === undefined ? maxTokens : budget - used;
    const tokens = Math.min(maxTokens, remaining);
    if (tokens < minimumTokens) throw new AiUnavailable('budget');
    const id = newId('rsv');
    await tx.insert(schema.aiTokenReservations).values({ workspaceId, id, providerId, tokens, expiresAt: new Date(Date.now() + ttlMs) });
    return { id, tokens };
  });
}

export type SettleOutcome = 'settled' | 'fallback' | 'held';

/** The first instant of the next UTC month: a usage write that failed keeps its hold through the month. */
export const nextMonthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** Reserve durably before I/O. Every metered call's hold lasts until the start of the month after
 * next, so a call that crosses a UTC month-end is still covered. Successful settlement deletes the hold immediately. A crash/outage keeps conservative budget
 * coverage until this deadline instead of freeing billed usage after five minutes. */
export const billingReservationTtlMs = (now = new Date()) => nextMonthStart(nextMonthStart(now)).getTime() - now.getTime();

/**
 * Keeps a reservation counted past its normal five-minute TTL when its usage could not be
 * written (#355). The hold is the only remaining record of tokens the provider billed; letting
 * it expire would let later calls spend that budget again. Metered decision/copilot calls already
 * commit a hold through the following UTC month before provider I/O; this extension never
 * shortens that deadline. If the database is unavailable, the original deadline remains valid.
 */
export async function holdReservationForMonth(db: Db, workspaceId: string, reservationId: string, now = new Date()): Promise<boolean> {
  try {
    await db.withWorkspace(workspaceId, (tx) =>
      tx
        .update(schema.aiTokenReservations)
        .set({ expiresAt: sql`GREATEST(${schema.aiTokenReservations.expiresAt}, ${nextMonthStart(now)})` })
        .where(eq(schema.aiTokenReservations.id, reservationId)),
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'AI budget reservation extension failed; its pre-call deadline remains in force');
    return false;
  }
}

/**
 * Records what a reservation bought and releases the reservation in one transaction (#355).
 * `usedThisMonth` counts the committed `ai_calls` rows plus live reservations, so an atomic
 * swap means a concurrent call never sees neither: it sees the hold, or the usage, but not a
 * gap in which the month looks free.
 *
 * `write` must persist the call's tokens. When it fails, `fallback` (if given) writes the same
 * usage in its own transaction before the hold is released. If both fail the reservation is kept
 * on purpose and extended through the billing month: freeing it would let the month spend budget
 * the provider has already billed. The caller sees `'held'` and reports the failure.
 *
 * The write takes the same per-provider advisory lock as reservation and release (#941), so a
 * budget read either sees the hold or the usage, never a moment between them. Pass `providerId`
 * when the caller knows it; otherwise it is read from the immutable hold row first. Lock order is
 * always budget lock -> hold/usage rows, then any business rows the writer touches.
 */
export async function settleReservation(
  db: Db,
  workspaceId: string,
  reservationId: string,
  write: (tx: Tx) => Promise<void>,
  opts: {
    fallback?: () => Promise<void>;
    label?: string;
    providerId?: string;
    /** The call row the estimate was recorded on, and the real usage replacing it (#941 round 3). */
    callId?: string;
    usage?: { inputTokens: number; outputTokens: number };
  } = {},
): Promise<SettleOutcome> {
  try {
    await db.withWorkspace(workspaceId, async (tx) => {
      const providerId = opts.providerId ?? (await reservationProvider(tx, reservationId));
      if (!providerId) return;
      await lockBudget(tx, providerId);
      // Another settlement may have committed while this one waited for the lock. Its usage row
      // is already written, so writing again would count the call twice.
      const [hold] = await tx
        .select({
          id: schema.aiTokenReservations.id,
          estimatedTokens: schema.aiTokenReservations.estimatedTokens,
        })
        .from(schema.aiTokenReservations)
        .where(eq(schema.aiTokenReservations.id, reservationId))
        .for('update');
      if (!hold) return;
      if (hold.estimatedTokens !== null) {
        // Crash recovery already recorded the estimate and kept this row. Replace it with the
        // real usage exactly once, independent of the attempt/status fence, then delete the row.
        if (opts.callId && opts.usage)
          await tx
            .update(schema.aiCalls)
            .set({
              inputTokens: sql`GREATEST(0, ${schema.aiCalls.inputTokens} - ${hold.estimatedTokens} + ${opts.usage.inputTokens})`,
              outputTokens: sql`${schema.aiCalls.outputTokens} + ${opts.usage.outputTokens}`,
              // The first settlement fixed the billing period; a correction never moves it.
              billedAt: sql`coalesce(${schema.aiCalls.billedAt}, now())`,
            })
            .where(and(eq(schema.aiCalls.workspaceId, workspaceId), eq(schema.aiCalls.id, opts.callId)));
        await tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, reservationId));
        return;
      }
      await write(tx);
      await tx.delete(schema.aiTokenReservations).where(eq(schema.aiTokenReservations.id, reservationId));
    });
    return 'settled';
  } catch (err) {
    logger.error({ err, label: opts.label }, 'AI usage could not be recorded with its reservation');
  }
  if (!opts.fallback) {
    await holdReservationForMonth(db, workspaceId, reservationId);
    return 'held';
  }
  try {
    await opts.fallback();
  } catch (err) {
    logger.error({ err, label: opts.label }, 'AI usage could not be recorded at all; keeping the reservation');
    await holdReservationForMonth(db, workspaceId, reservationId);
    return 'held';
  }
  try {
    await releaseTokens(db, workspaceId, reservationId);
  } catch (err) {
    // The usage is durable; the hold is only double-counting until it expires, which is the safe
    // direction for a budget.
    logger.error({ err, label: opts.label }, 'AI usage was recorded but its reservation could not be released');
  }
  return 'fallback';
}

/** The fewest tokens worth starting another model step with (the hosted-run pattern). */
export const MIN_STEP_TOKENS = 100;

/** Tokens used by the steps so far (input and output), for a turn or run cap. */
export const tokensOfSteps = (steps: { usage: { inputTokens?: number; outputTokens?: number } }[]) =>
  steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0), 0);

export interface StepBudget {
  /** No further model call: too little of the allowance is left for a useful step. */
  stop: boolean;
  /** The output cap for the next step. */
  maxOutputTokens: number;
}

/**
 * The budget for the next model step of a capped turn: what is left of the allowance after the
 * steps already taken and after an estimate of this step's input (prompt, history, tool results).
 * A turn stops before the call when the room left cannot pay for a useful step, so the cap is
 * checked before the model is asked again rather than after it has overspent (#356).
 */
export function stepBudget(input: {
  allowance: number;
  used: number;
  maxOutputTokens: number;
  estimatedInput?: number;
  minStepTokens?: number;
}): StepBudget {
  const min = input.minStepTokens ?? MIN_STEP_TOKENS;
  const remaining = input.allowance - input.used;
  if (remaining < min) return { stop: true, maxOutputTokens: 1 };
  const room = remaining - Math.max(0, input.estimatedInput ?? 0);
  if (room < min) return { stop: true, maxOutputTokens: 1 };
  return { stop: false, maxOutputTokens: Math.max(1, Math.min(input.maxOutputTokens, room)) };
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

/**
 * The provider's URL under the server's egress policy (#1131): a workspace admin sets it, so it
 * gets the same guard as a webhook or connector URL. `EGRESS_ALLOWED_HOSTS` keeps a local Ollama
 * or a homelab gateway working.
 */
function assertBaseUrlAllowed(baseUrl: string, egress: EgressPolicy | undefined) {
  const problem = checkUrl(baseUrl, egress ?? { allowedHosts: [] });
  if (problem) throw new AppError('invalid_input', `The provider URL is not allowed: ${problem}.`);
}

export async function languageModel(
  tx: Tx,
  row: ProviderRow,
  kp: KeyProvider,
  tier: 'default' | 'fast',
  egress?: EgressPolicy,
): Promise<ReadyModel> {
  if (!row.secrets || !row.secretsKeyId) throw new AiUnavailable('no_key');
  const { apiKey } = await openJson<{ apiKey: string }>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId);
  const modelId = (tier === 'fast' && row.models.fast) || row.models.default;
  // Every request goes through the guard again, after DNS resolution and without redirects, but
  // the body stays a stream: the copilot reads its answer as it arrives. Without an explicit
  // policy private networks are refused (the server always passes its config).
  const fetch = egressFetchStream(egress ?? { allowedHosts: [] });
  const model =
    row.kind === 'anthropic-compatible'
      ? createAnthropic({ baseURL: row.baseUrl, apiKey, fetch })(modelId)
      : createOpenAICompatible({
          name: 'byok',
          baseURL: row.baseUrl,
          apiKey,
          fetch,
          supportsStructuredOutputs: row.structuredOutputs,
          includeUsage: true,
        })(modelId);
  return { providerId: row.id, modelId, model };
}

/** The model for a use, after checking that the provider is enabled and within its budget. */
export async function modelFor(
  tx: Tx,
  kp: KeyProvider,
  use: AiUse,
  tier: 'default' | 'fast' = 'default',
  egress?: EgressPolicy,
): Promise<ReadyModel> {
  const rows = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.enabled, true));
  const row = rows.find((r) => r.useFor.includes(use));
  if (!row) throw new AiUnavailable('no_provider');
  if (row.monthlyTokenBudget !== null && (await usedThisMonth(tx, row.id)) >= row.monthlyTokenBudget) throw new AiUnavailable('budget');
  return languageModel(tx, row, kp, tier, egress);
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
    assertBaseUrlAllowed(input.baseUrl, ctx.services.egress);
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
    if (rest.baseUrl) assertBaseUrlAllowed(rest.baseUrl, ctx.services.egress);
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
