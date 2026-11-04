import { createHash } from 'node:crypto';
import { type DecisionQuestion, decisionQuestions, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Db, Tx } from '@agentic-marketing/db';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import { type KeyProvider, openJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, sql } from 'drizzle-orm';
import { personalDataIn } from './context';
import { AiUnavailable, estimateTokens, releaseTokens, reserveTokens } from './providers';

// The decision-model adapter (#194): TypeSafe's System One API, reached through CommandCode
// (https://api.commandcode.ai/provider/v1) or TypeSafe directly (https://api.typesafe.ai/v1).
// One request carries a state and typed questions; the answer is probabilities and confidence,
// never text. Both endpoints take the same body: POST <baseUrl>/systemone.
//
// Request shape (confirmed against docs.typesafe.ai/api/system-one):
//   { model, state, questions: { [key]: { type: 'noul'|'choice'|'score', instructions, criteria? } } }
// Response:
//   { model, answers: { [key]: { type, noul|choice|score, confidence?, probabilities?, legend? } },
//     usage: { input_tokens, output_tokens } }
//
// Free-form state is never logged; the call row keeps a state hash and the question set. A state
// with personal data is refused unless the provider is explicitly marked allowPersonalData (a
// no-retention agreement, not available for JEV on CommandCode).

export type DecisionAnswerType = DecisionQuestion['type'];

export interface DecisionAnswer {
  key: string;
  type: DecisionAnswerType;
  /** Predicted probability in 0–1: noul's probability, the chosen label's probability, or score / (levels-1). */
  probability: number;
  /** The chosen label of a choice question. */
  label?: string;
  /** The raw score of a score question (0 … levels-1). */
  value?: number;
  confidence?: number;
  /** The full distribution; choice labels or level numbers as keys. */
  probabilities: Record<string, number>;
}

export interface DecisionResult {
  providerId: string;
  /** The model id from the request, e.g. typesafe/jev. */
  model: string;
  /** The model version the API answered with, e.g. jev-1.14.0 (may differ from an alias). */
  modelVersion: string;
  answers: DecisionAnswer[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class DecisionError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'too_many_questions'
      | 'too_large'
      | 'personal_data'
      | 'provider_error'
      | 'invalid_response'
      | 'timeout'
      | 'no_provider',
    message: string,
  ) {
    super(message);
  }
}

/** Limits from #194: at most 100 questions, 64K tokens of state plus questions. */
export const MAX_QUESTIONS = 100;
export const MAX_REQUEST_TOKENS = 64_000;
/** A conservative bound for one question beside the state (the documented 32K state+question). */
export const MAX_STATE_AND_QUESTION_TOKENS = 32_000;

/** ~4 characters per token, the same estimate the budget path uses. */
const tokensOf = (v: unknown) => Math.ceil(JSON.stringify(v ?? '').length / 4);

export function systemOneUrl(baseUrl: string): string {
  // A loop, not a regex: the base URL is user input and `/\/+$/` backtracks on many slashes.
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  const trimmed = baseUrl.slice(0, end);
  return trimmed.endsWith('/systemone') ? trimmed : `${trimmed}/systemone`;
}

/** Refuses a request the provider would reject, before it is metered or sent. */
export function checkDecisionLimits(state: unknown, questions: DecisionQuestion[]) {
  if (questions.length > MAX_QUESTIONS)
    throw new DecisionError('too_many_questions', `At most ${MAX_QUESTIONS} questions per call; ${questions.length} were given.`);
  const total = tokensOf(state) + tokensOf(wireQuestions(questions));
  if (total > MAX_REQUEST_TOKENS)
    throw new DecisionError('too_large', `The state and questions are about ${total} tokens; the limit is ${MAX_REQUEST_TOKENS}.`);
  const longest = Math.max(...questions.map((q) => tokensOf(q)));
  if (tokensOf(state) + longest > MAX_STATE_AND_QUESTION_TOKENS)
    throw new DecisionError(
      'too_large',
      `The state and the longest question are about ${tokensOf(state) + longest} tokens; the limit is ${MAX_STATE_AND_QUESTION_TOKENS}.`,
    );
}

/** The wire form of each question: the key is the response key, the model never sees it. */
export function wireQuestions(questions: DecisionQuestion[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const q of questions) {
    if (q.type === 'noul')
      out[q.key] = {
        type: 'noul',
        instructions: q.instructions,
        ...(q.criteria && Object.keys(q.criteria).length ? { criteria: q.criteria } : {}),
      };
    else if (q.type === 'choice') out[q.key] = { type: 'choice', instructions: q.instructions, criteria: q.criteria };
    else out[q.key] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
  }
  return out;
}

/** The System One request body; questions are validated and keys must be unique. */
export function systemOneRequest(model: string, state: unknown, questions: DecisionQuestion[]) {
  const parsed = decisionQuestions.parse(questions);
  if (state === undefined || state === null) throw new DecisionError('invalid_request', 'A decision call needs a state.');
  checkDecisionLimits(state, parsed);
  return { model, state, questions: wireQuestions(parsed) };
}

const number = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecisionError('invalid_response', `The answer has no numeric ${field}.`);
  return v;
};

/** A probability, confidence or distribution entry: finite and inside 0–1 (#353). */
const probability = (v: unknown, field: string): number => {
  const n = number(v, field);
  if (n < 0 || n > 1) throw new DecisionError('invalid_response', `The ${field} is outside 0–1.`);
  return n;
};

const distribution = (v: unknown): Record<string, number> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new DecisionError('invalid_response', 'The answer has no probabilities object.');
  // A plain own-property record: Object.fromEntries creates own keys (even "__proto__") and stays
  // an ordinary object, which Drizzle needs when it serialises the JSONB column. `Object.hasOwn`
  // still keeps prototype names out of the choice-label lookup (#361).
  const out = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, probability(x, `probability for ${k}`)]),
  ) as Record<string, number>;
  const total = Object.values(out).reduce((sum, x) => sum + x, 0);
  if (Object.keys(out).length && Math.abs(total - 1) > 0.01)
    logger.warn({ total, labels: Object.keys(out).length }, 'decision provider returned a probability distribution that does not sum to 1');
  return out;
};

/** A usage count: a finite, non-negative whole number. A provider cannot spend negative or fractional tokens. */
const tokens = (v: unknown, field: string, fallback: number): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
    throw new DecisionError('invalid_response', `The usage has an invalid ${field}.`);
  return v;
};

/** Normalises the provider's answers to the questions that were asked. */
export function parseSystemOneAnswers(questions: DecisionQuestion[], body: unknown): { model: string; answers: DecisionAnswer[] } {
  const b = body as { model?: unknown; answers?: unknown } | null;
  if (!b || typeof b !== 'object' || !b.answers || typeof b.answers !== 'object')
    throw new DecisionError('invalid_response', 'The decision provider returned no answers.');
  const answers = b.answers as Record<string, Record<string, unknown>>;
  const out: DecisionAnswer[] = [];
  for (const q of questions) {
    const a = answers[q.key];
    if (!a || typeof a !== 'object') throw new DecisionError('invalid_response', `The answer for "${q.key}" is missing.`);
    if (a.type !== q.type)
      throw new DecisionError('invalid_response', `The answer for "${q.key}" is a ${String(a.type)}, not a ${q.type}.`);
    if (q.type === 'noul') {
      const p = probability(a.noul, `probability for "${q.key}"`);
      out.push({ key: q.key, type: 'noul', probability: p, probabilities: { true: p, false: 1 - p } });
    } else if (q.type === 'choice') {
      const label = String(a.choice ?? '');
      const probabilities = distribution(a.probabilities);
      // Own keys only: `label in object` walks Object.prototype, so "constructor" used to be
      // accepted with a function-valued probability (#361).
      if (!Object.hasOwn(probabilities, label) || !Object.hasOwn(q.criteria, label))
        throw new DecisionError('invalid_response', `The answer for "${q.key}" chose an unknown label.`);
      out.push({
        key: q.key,
        type: 'choice',
        probability: probabilities[label],
        label,
        confidence: a.confidence === undefined ? undefined : probability(a.confidence, 'confidence'),
        probabilities,
      });
    } else {
      const value = number(a.score, 'score');
      const top = q.criteria.length - 1;
      if (value < 0 || value > top) throw new DecisionError('invalid_response', `The answer for "${q.key}" is outside 0–${top}.`);
      out.push({
        key: q.key,
        type: 'score',
        probability: top ? value / top : 0,
        value,
        confidence: a.confidence === undefined ? undefined : probability(a.confidence, 'confidence'),
        probabilities: distribution(a.probabilities),
      });
    }
  }
  return { model: typeof b.model === 'string' ? b.model : '', answers: out };
}

export interface DecisionProvider {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  allowPersonalData: boolean;
}

/** The decision provider: an explicit one, else the enabled provider used for decisions. */
export async function decisionProvider(tx: Tx, kp: KeyProvider, providerId?: string): Promise<DecisionProvider> {
  const rows = await tx.select().from(schema.aiProviders).where(eq(schema.aiProviders.enabled, true));
  const row = providerId
    ? rows.find((r) => r.id === providerId)
    : (rows.find((r) => r.kind === 'decision' && r.useFor.includes('decisions')) ?? rows.find((r) => r.kind === 'decision'));
  if (!row)
    throw new DecisionError(
      'no_provider',
      providerId ? `AI provider ${providerId} is not a decision provider.` : 'No decision provider is set up.',
    );
  if (row.kind !== 'decision')
    throw new DecisionError(
      'no_provider',
      providerId ? `AI provider ${providerId} is not a decision provider.` : 'No decision provider is set up.',
    );
  if (!row.secrets || !row.secretsKeyId) throw new AiUnavailable('no_key');
  const { apiKey } = await openJson<{ apiKey: string }>(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId);
  return {
    providerId: row.id,
    model: row.models.default,
    baseUrl: row.baseUrl,
    apiKey,
    allowPersonalData: row.allowPersonalData,
  };
}

/**
 * The free text of each question: its key, instructions and criteria descriptions, plus the
 * criteria labels. They are swept as plain strings, so a label such as "email" (a channel name)
 * is not mistaken for the person's address, while an address written into a label or description
 * is still refused.
 */
function questionTexts(questions: unknown): unknown[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((q) => {
    if (!q || typeof q !== 'object') return [q];
    const { key, instructions, criteria } = q as { key?: unknown; instructions?: unknown; criteria?: unknown };
    const labels = Array.isArray(criteria)
      ? criteria
      : criteria && typeof criteria === 'object'
        ? Object.entries(criteria as Record<string, unknown>).flatMap(([label, description]) => [label, description])
        : [];
    return [key, instructions, ...labels];
  });
}

/**
 * Refuses a request with personal data when the provider has no no-retention agreement. The sweep
 * covers the whole request, state and question text alike (#352); it has no depth limit.
 */
export function assertStateAllowed(state: unknown, provider: Pick<DecisionProvider, 'allowPersonalData' | 'model'>, questions?: unknown) {
  if (provider.allowPersonalData) return;
  const found = personalDataIn(state);
  if (found)
    throw new DecisionError(
      'personal_data',
      `The state contains ${found} data, and decision model ${provider.model} has no zero-data-retention agreement. Send only non-personal traits, segment ids, event counts and context, or use a provider marked allowPersonalData under a no-retention agreement.`,
    );
  const inQuestions = personalDataIn(questionTexts(questions));
  if (inQuestions)
    throw new DecisionError(
      'personal_data',
      `A question contains ${inQuestions} data, and decision model ${provider.model} has no zero-data-retention agreement. Remove contact details from the question instructions and criteria, or use a provider marked allowPersonalData under a no-retention agreement.`,
    );
}

export const stateHash = (state: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(state ?? null))
    .digest('hex');

/** The largest response a decision provider may send: enough for 100 typed answers. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Sends one request. Never called with a real endpoint from tests. */
export async function callSystemOne(
  provider: DecisionProvider,
  state: unknown,
  questions: DecisionQuestion[],
  opts: { timeoutMs?: number; egress?: EgressPolicy; maxBytes?: number } = {},
): Promise<{ modelVersion: string; answers: DecisionAnswer[]; inputTokens: number; outputTokens: number }> {
  const body = systemOneRequest(provider.model, state, questions);
  assertStateAllowed(state, provider, questions);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let res: { status: number; body: string };
  try {
    // The same egress guard as webhooks and connectors (#354): no redirects, no private target
    // unless EGRESS_ALLOWED_HOSTS allows it, a total deadline and a bounded read. Without an
    // explicit policy, private networks are refused (the server always passes its config).
    res = await safeRequest(
      systemOneUrl(provider.baseUrl),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
        maxBytes: opts.maxBytes ?? MAX_RESPONSE_BYTES,
      },
      opts.egress ?? { allowedHosts: [] },
    );
  } catch (err) {
    if ((err as Error).message.startsWith('timed out after'))
      throw new DecisionError('timeout', `The decision provider did not answer within ${timeoutMs} ms.`);
    throw new DecisionError('provider_error', `The decision provider could not be reached: ${(err as Error).message}`);
  }
  const text = res.body;
  if (res.status < 200 || res.status >= 300) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === 'string') detail = parsed.detail;
    } catch {
      // keep the raw text
    }
    throw new DecisionError('provider_error', `The decision provider answered ${res.status}: ${detail}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DecisionError('invalid_response', 'The decision provider returned invalid JSON.');
  }
  const parsed = parseSystemOneAnswers(questions, json);
  const usage = (json as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage ?? {};
  return {
    modelVersion: parsed.model,
    answers: parsed.answers,
    inputTokens: tokens(usage.input_tokens, 'input_tokens', estimateTokens(body, 0)),
    outputTokens: tokens(usage.output_tokens, 'output_tokens', 0),
  };
}

/**
 * One metered decision call: reserves the provider's budget, calls the model, frees the hold.
 * The caller records the ai_calls row (kind score) so usage counts even when the call fails.
 */
export async function decisionCall(
  db: Db,
  workspaceId: string,
  provider: DecisionProvider,
  state: unknown,
  questions: DecisionQuestion[],
  opts: { timeoutMs?: number; egress?: EgressPolicy } = {},
): Promise<Omit<DecisionResult, 'providerId' | 'model'>> {
  const request = systemOneRequest(provider.model, state, questions);
  const reservation = await reserveTokens(db, workspaceId, provider.providerId, estimateTokens(request, 20 * questions.length + 50));
  const started = Date.now();
  try {
    const r = await callSystemOne(provider, state, questions, opts);
    return { ...r, latencyMs: Date.now() - started };
  } finally {
    await releaseTokens(db, workspaceId, reservation);
  }
}

/** Writes the newest value of a named score for a person, with its TTL, in the caller's transaction. */
export async function insertProfileScore(
  tx: Tx,
  workspaceId: string,
  score: {
    profileId: string;
    key: string;
    answer: DecisionAnswer;
    model: string;
    modelVersion: string;
    callId: string | null;
    ttlHours: number;
  },
): Promise<Date | null> {
  // Lock and recheck the profile in the score's own transaction. the existing erasure DELETE locks the profile
  // before its foreign key cascades to profile_scores, so an erasure that got there first leaves no profile to lock
  // and no score is written; an erasure that arrives later waits and then deletes this row.
  const locked = await tx.execute<{ id: string }>(
    sql`SELECT id FROM profiles WHERE workspace_id = ${workspaceId} AND id = ${score.profileId} FOR UPDATE`,
  );
  if (!locked.rows.length) return null;
  const expiresAt = new Date(Date.now() + score.ttlHours * 3_600_000);
  await tx
    .insert(schema.profileScores)
    .values({
      workspaceId,
      profileId: score.profileId,
      key: score.key,
      value: score.answer.probability,
      confidence: score.answer.confidence ?? null,
      probabilities: score.answer.probabilities,
      model: score.model,
      modelVersion: score.modelVersion,
      callId: score.callId,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [schema.profileScores.workspaceId, schema.profileScores.profileId, schema.profileScores.key],
      set: {
        value: score.answer.probability,
        confidence: score.answer.confidence ?? null,
        probabilities: score.answer.probabilities,
        model: score.model,
        modelVersion: score.modelVersion,
        callId: score.callId,
        createdAt: new Date(),
        expiresAt,
      },
    });
  return expiresAt;
}

/** Writes the newest value of a named score for a person, with its TTL. */
export async function storeProfileScore(
  db: Db,
  workspaceId: string,
  score: {
    profileId: string;
    key: string;
    answer: DecisionAnswer;
    model: string;
    modelVersion: string;
    callId: string | null;
    ttlHours: number;
  },
) {
  return db.withWorkspace(workspaceId, (tx) => insertProfileScore(tx, workspaceId, score));
}

/**
 * The non-personal state for a person (#194): non-personal agent-visible traits, segment ids,
 * event counts and the caller's contextual fields — never identifiers, never free text. Null when
 * the person is gone. Throws DecisionError('personal_data') if a contextual value is personal.
 */
export async function nonPersonalState(
  tx: Tx,
  workspaceId: string,
  events: EventStore,
  profileId: string,
  contextual?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const [p] = await tx
    .select({ id: schema.profiles.id, traits: schema.profiles.traits })
    .from(schema.profiles)
    .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, profileId)));
  if (!p) return null;
  const plan = await publishedSingleton(tx, 'tracking_plan');
  const visible = new Set(plan?.traits.filter((t) => t.pii === 'none' && t.agentVisible).map((t) => t.name));
  // Fail closed without a published plan (#357): an unlisted trait may be free text, a job title
  // or a city, so it is not sent just because the plan has not been published yet.
  const traits = plan ? Object.fromEntries(Object.entries(p.traits).filter(([k]) => visible.has(k))) : {};
  const segments = await tx
    .select({ id: schema.segmentMemberships.segmentId })
    .from(schema.segmentMemberships)
    .where(and(eq(schema.segmentMemberships.workspaceId, workspaceId), eq(schema.segmentMemberships.profileId, profileId)));
  const ids = await tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value })
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.workspaceId, workspaceId), eq(schema.identifiers.profileId, profileId)));
  const recent = await events
    .eventsOf(
      workspaceId,
      {
        anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
        userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
      },
      { limit: 100 },
    )
    .catch(() => []);
  const counts: Record<string, number> = {};
  for (const e of recent) if (e.name) counts[e.name] = (counts[e.name] ?? 0) + 1;
  const state = {
    traits,
    segments: segments.map((s) => s.id).sort(),
    eventCounts: counts,
    ...(contextual ? { context: contextual } : {}),
  };
  const found = personalDataIn(state);
  if (found)
    throw new DecisionError(
      'personal_data',
      `The person's non-personal state still contains ${found} data (check the tracking plan and the contextual fields).`,
    );
  return state;
}
