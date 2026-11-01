import { createHash } from 'node:crypto';
import { type DecisionQuestion, decisionQuestions, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Db, Tx } from '@agentic-marketing/db';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { type KeyProvider, openJson } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';
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
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/systemone$/.test(trimmed) ? trimmed : `${trimmed}/systemone`;
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

const distribution = (v: unknown): Record<string, number> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new DecisionError('invalid_response', 'The answer has no probabilities object.');
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = number(x, `probability for ${k}`);
  return out;
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
      const p = number(a.noul, 'noul');
      if (p < 0 || p > 1) throw new DecisionError('invalid_response', `The answer for "${q.key}" is outside 0–1.`);
      out.push({ key: q.key, type: 'noul', probability: p, probabilities: { true: p, false: 1 - p } });
    } else if (q.type === 'choice') {
      const label = String(a.choice ?? '');
      const probabilities = distribution(a.probabilities);
      if (!(label in probabilities) || !(label in q.criteria))
        throw new DecisionError('invalid_response', `The answer for "${q.key}" chose an unknown label.`);
      out.push({
        key: q.key,
        type: 'choice',
        probability: probabilities[label] ?? 0,
        label,
        confidence: a.confidence === undefined ? undefined : number(a.confidence, 'confidence'),
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
        confidence: a.confidence === undefined ? undefined : number(a.confidence, 'confidence'),
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

/** Refuses a state with personal data when the provider has no no-retention agreement. */
export function assertStateAllowed(state: unknown, provider: Pick<DecisionProvider, 'allowPersonalData' | 'model'>) {
  if (provider.allowPersonalData) return;
  const found = personalDataIn(state);
  if (found)
    throw new DecisionError(
      'personal_data',
      `The state contains ${found} data, and decision model ${provider.model} has no zero-data-retention agreement. Send only non-personal traits, segment ids, event counts and context, or use a provider marked allowPersonalData under a no-retention agreement.`,
    );
}

export const stateHash = (state: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(state ?? null))
    .digest('hex');

/** Sends one request. Never called with a real endpoint from tests. */
export async function callSystemOne(
  provider: DecisionProvider,
  state: unknown,
  questions: DecisionQuestion[],
  opts: { timeoutMs?: number } = {},
): Promise<{ modelVersion: string; answers: DecisionAnswer[]; inputTokens: number; outputTokens: number }> {
  const body = systemOneRequest(provider.model, state, questions);
  let res: Response;
  try {
    res = await fetch(systemOneUrl(provider.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError')
      throw new DecisionError('timeout', `The decision provider did not answer within ${opts.timeoutMs ?? 30_000} ms.`);
    throw new DecisionError('provider_error', `The decision provider could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
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
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : estimateTokens(body, 0),
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
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
  opts: { timeoutMs?: number } = {},
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
  const expiresAt = new Date(Date.now() + score.ttlHours * 3_600_000);
  await db.withWorkspace(workspaceId, (tx) =>
    tx
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
      }),
  );
  return expiresAt;
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
  const traits = plan
    ? Object.fromEntries(Object.entries(p.traits).filter(([k]) => visible.has(k)))
    : (p.traits as Record<string, unknown>);
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
