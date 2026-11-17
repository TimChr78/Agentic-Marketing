import { type DecisionQuestion, decisionQuestions, type PromptDefinition, publishedSingleton } from '@agentic-marketing/artifacts';
import { safeErrorText } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { EgressPolicy } from '@agentic-marketing/integrations';
import { canonicalProfile, lockProfileRows } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { aiAllowed, personContext, redact } from './context';
import {
  type DecisionAnswer,
  DecisionError,
  decisionCall,
  decisionProvider,
  insertProfileScore,
  nonPersonalState,
  stateHash,
} from './decision';
import { promptVersion, runClassify, runPrompt, runTestCase } from './prompts';
import {
  AiUnavailable,
  billingReservationTtlMs,
  estimatedUsage,
  estimateTokens,
  lockBudget,
  modelFor,
  type ReadyModel,
  releaseTokens,
  reserveTokens,
  settleReservation,
  usageOfError,
} from './providers';

// The AI worker: answers the AI steps of journeys. A step is a pending row in ai_calls; the
// worker claims it with a lease, builds the context and checks consent in one transaction,
// calls the model outside any transaction, then stores the outcome on the participant and wakes
// it. Whatever goes wrong, the step gets a fallback with the reason, never a stuck participant.

export interface AiStepDeps {
  kp: KeyProvider;
  events: EventStore;
  /** The server's egress policy; decision calls go through the same guard as webhooks (#354). */
  egress?: EgressPolicy;
}

type CallRow = typeof schema.aiCalls.$inferSelect;
const LEASE_MS = 120_000;

interface Prepared {
  def: PromptDefinition;
  version: number;
  model?: ReadyModel;
  person?: Record<string, unknown>;
  fallback?: string;
  /** Per-segment text cache (generate prompts with `cache`): the key, and the slots when cached. */
  cache?: { key: string; slots?: Record<string, string> };
}

/** Whether an answered call is set aside for human review (prompts with review.sampleRate). */
const sampled = (def: PromptDefinition | undefined) => !!def?.review && Math.random() < def.review.sampleRate;

/**
 * The cache key of a person for a prompt with `cache`: which of its segments they are in. The
 * model then sees only those segments' names, so the text holds nothing personal and can serve
 * everyone with the same key.
 */
async function segmentKey(tx: Tx, profileId: string, segments: string[]) {
  const rows = await tx
    .select({ id: schema.segmentMemberships.segmentId, name: schema.artifacts.name })
    .from(schema.segmentMemberships)
    .innerJoin(
      schema.artifacts,
      and(
        eq(schema.artifacts.workspaceId, schema.segmentMemberships.workspaceId),
        eq(schema.artifacts.id, schema.segmentMemberships.segmentId),
      ),
    )
    .where(and(eq(schema.segmentMemberships.profileId, profileId), inArray(schema.segmentMemberships.segmentId, segments)));
  const inside = rows.sort((a, b) => a.id.localeCompare(b.id));
  return { key: inside.map((r) => r.id).join('+') || 'none', names: inside.map((r) => r.name) };
}

async function prepare(tx: Tx, c: CallRow, deps: AiStepDeps): Promise<Prepared | null> {
  const p = await promptVersion(tx, c.promptId ?? '');
  if (!p) return null;
  const base = { def: p.def, version: p.version };
  // The participant must still wait at this step (it may have timed out meanwhile).
  const [part] = await tx
    .select({ node: schema.journeyParticipants.node, seq: schema.journeyParticipants.seq, status: schema.journeyParticipants.status })
    .from(schema.journeyParticipants)
    .where(eq(schema.journeyParticipants.id, c.participantId ?? 0));
  if (part?.status !== 'waiting' || part.node !== c.node || part.seq !== c.seq)
    return { ...base, fallback: 'too_late: the step was no longer waiting' };
  const consent = await aiAllowed(tx, c.workspaceId, c.profileId ?? '');
  if (!consent.ok) return { ...base, fallback: consent.reason };
  try {
    const model = await modelFor(tx, deps.kp, 'journeys', p.def.model);
    if (p.def.kind === 'generate' && p.def.cache) {
      const { key, names } = await segmentKey(tx, c.profileId ?? '', p.def.cache.segments);
      const [hit] = await tx
        .select({ slots: schema.aiTextCache.slots })
        .from(schema.aiTextCache)
        .where(
          and(
            eq(schema.aiTextCache.promptId, c.promptId ?? ''),
            eq(schema.aiTextCache.promptVersion, p.version),
            eq(schema.aiTextCache.cacheKey, key),
            sql`${schema.aiTextCache.expiresAt} > now()`,
          ),
        );
      return { ...base, model, person: { segments: names }, cache: { key, slots: hit?.slots } };
    }
    const trigger = (c.input as { trigger?: { name: string; properties: Record<string, unknown> } | null }).trigger ?? undefined;
    const person = await personContext(tx, c.workspaceId, deps.kp, deps.events, c.profileId ?? '', trigger);
    if (!person) return { ...base, fallback: 'no_profile: the person does not exist (or was erased)' };
    return { ...base, model, person: person as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof AiUnavailable) return { ...base, fallback: `${err.reason}: ${err.message}` };
    throw err;
  }
}

type UsageFields = {
  inputTokens?: number;
  outputTokens?: number;
  usageEstimated?: boolean;
  providerId?: string | null;
};

/**
 * Add one attempt's usage to the row without touching its terminal fields. A late attempt whose
 * lease was taken over still spent tokens; the reservation's atomic delete is what makes this
 * happen exactly once per attempt (#941 review).
 */
async function addUsageOnly(tx: Tx, c: CallRow, out: UsageFields) {
  await tx
    .update(schema.aiCalls)
    .set({
      inputTokens: sql`${schema.aiCalls.inputTokens} + ${out.inputTokens ?? 0}`,
      outputTokens: sql`${schema.aiCalls.outputTokens} + ${out.outputTokens ?? 0}`,
      billedAt: sql`coalesce(${schema.aiCalls.billedAt}, now())`,
      usageEstimated: sql`${schema.aiCalls.usageEstimated} OR ${out.usageEstimated === true || c.usageEstimated}`,
      providerId: sql`coalesce(${schema.aiCalls.providerId}, ${out.providerId ?? c.providerId ?? null})`,
    })
    .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)));
}

/** The row is still owned by this attempt; a late attempt may add usage but cannot write the outcome. */
async function ownsAttempt(tx: Tx, c: CallRow): Promise<boolean | null> {
  const [row] = await tx
    .select({ attempts: schema.aiCalls.attempts })
    .from(schema.aiCalls)
    .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)))
    .for('update');
  if (!row) return null;
  return row.attempts === c.attempts;
}

export async function finishIn(
  tx: Tx,
  c: CallRow,
  prep: (Pick<Prepared, 'person'> & Partial<Pick<Prepared, 'def' | 'version' | 'model'>>) | null,
  out: {
    status: 'done' | 'fallback' | 'failed';
    option?: string;
    rationale?: string;
    slots?: Record<string, string>;
    /** A decision step's routing probability (0–1). */
    probability?: number;
    output?: unknown;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** The provider usage was unknown and the reserved estimate was recorded (#941). */
    usageEstimated?: boolean;
    latencyMs?: number;
    cached?: boolean;
    providerId?: string;
    model?: string;
    /**
     * A decision score to commit in the same transaction as the wakeup, before the participant
     * can be claimed again (#350, #351).
     */
    storeScore?: {
      profileId: string;
      key: string;
      answer: DecisionAnswer;
      model: string;
      modelVersion: string;
      callId: string | null;
      ttlHours: number;
    };
  },
) {
  // Fence by attempt: a retry that took the lease over must keep the terminal outcome, while a
  // late original still adds the tokens the provider billed (#941 review).
  const owns = await ownsAttempt(tx, c);
  if (owns === null) return;
  if (!owns) {
    await addUsageOnly(tx, c, out);
    return;
  }
  const outcome = {
    seq: c.seq,
    ...(out.option ? { option: out.option, rationale: out.rationale ?? '' } : {}),
    ...(out.probability !== undefined ? { probability: out.probability } : {}),
    ...(out.status !== 'done' ? { fallback: out.error ?? 'failed' } : {}),
  };
  // On a fallback the journey fills the slots with the prompt's fallback texts itself.
  const content = out.slots;
  // A decision call logs a state hash and a sanitised question set, never the person's state
  // or a trigger event with its properties (#358). Redacting the questions also keeps contact
  // details out of a refused call's audit row (#352).
  const input: Record<string, unknown> = { ...(c.input as Record<string, unknown>) };
  if (c.kind === 'score') {
    input.questions = Array.isArray(input.questions) ? input.questions.map((q) => redact(q)) : input.questions;
    const trigger = input.trigger as { name?: unknown } | string | null | undefined;
    const name = trigger && typeof trigger === 'object' ? trigger.name : trigger;
    input.trigger = typeof name === 'string' ? { name } : null;
  }
  // A decision step verifies the still-waiting participant and the profile it belongs to before
  // writing anything (#351, #359 interplay). A step that finds the participant gone or not waiting,
  // or the profile erased, is late and commits no score, so an erased person's scores cannot come
  // back.
  //
  // Lock order: profile -> participant -> profile_scores, the shared row order (see
  // `packages/profiles/src/identity.ts`): an SDK batch that merges this person locks the profile
  // rows before it moves the participant rows, and the journey sweep locks the profile row before
  // it claims the participant row. Locking the participant first deadlocked with a merge (#1011
  // review). `removeProfiles` deletes the person's participants before the profile row and takes the
  // same profile lock first, and the profile row's foreign key cascades the score deletion.
  let waiting = true;
  if (c.kind === 'score') {
    // The call keeps its own profile id even when a merge has folded it away (the score is stored
    // under it), so lock that row whether or not it is the person today — before the participant.
    const lockedProfile = c.profileId ? await lockProfileRows(tx, c.workspaceId, [c.profileId], { includeMerged: true }) : [];
    const lockedParticipant = await tx.execute<{ id: string }>(sql`
        SELECT id FROM journey_participants
        WHERE workspace_id = ${c.workspaceId} AND id = ${c.participantId} AND node = ${c.node} AND seq = ${c.seq} AND status = 'waiting'
        FOR UPDATE`);
    waiting = lockedParticipant.rows.length > 0 && (!c.profileId || lockedProfile.length > 0);
    // The score and the wakeup commit together: a worker cannot claim the participant and read a
    // missing (or previous) value, and a failed score write leaves the step waiting to retry.
    if (waiting && out.storeScore) await insertProfileScore(tx, c.workspaceId, out.storeScore);
  }
  // Wake the participant only if it still waits at this step; otherwise the answer came too late.
  const woke = waiting
    ? await tx.execute(sql`
      UPDATE journey_participants SET
        context = jsonb_set(
          CASE WHEN ${content ? JSON.stringify(content) : null}::jsonb IS NULL THEN context
               ELSE jsonb_set(context, '{content}', coalesce(context->'content', '{}') || ${content ? JSON.stringify(content) : null}::jsonb) END,
          '{ai}', coalesce(context->'ai', '{}') || jsonb_build_object(${c.node}::text, ${JSON.stringify(outcome)}::jsonb)),
        due_at = now(), updated_at = now()
      WHERE workspace_id = ${c.workspaceId} AND id = ${c.participantId} AND node = ${c.node} AND seq = ${c.seq} AND status = 'waiting'`)
    : { rowCount: 0 };
  const late = !woke.rowCount && out.status === 'done';
  await tx
    .update(schema.aiCalls)
    .set({
      status: late ? 'fallback' : out.status,
      leaseUntil: null,
      promptVersion: prep?.version ?? null,
      providerId: prep?.model?.providerId ?? out.providerId ?? c.providerId ?? null,
      model: prep?.model?.modelId ?? out.model ?? null,
      input: { ...input, ...(c.kind !== 'score' && prep?.person ? { person: prep.person } : {}) },
      output: out.output ?? null,
      rationale: out.rationale ?? null,
      error: late ? 'too_late: the step had timed out and took its fallback' : (out.error ?? null),
      // Accumulate in SQL rather than from the claim snapshot: a late attempt may already have
      // added its tokens, and both attempts were billed (#941 review).
      inputTokens: sql`${schema.aiCalls.inputTokens} + ${out.inputTokens ?? 0}`,
      outputTokens: sql`${schema.aiCalls.outputTokens} + ${out.outputTokens ?? 0}`,
      billedAt: sql`coalesce(${schema.aiCalls.billedAt}, now())`,
      usageEstimated: sql`${schema.aiCalls.usageEstimated} OR ${out.usageEstimated === true || c.usageEstimated}`,
      reservationId: null,
      latencyMs: out.latencyMs ?? null,
      cached: out.cached ?? false,
      reviewStatus: !late && out.status === 'done' && sampled(prep?.def) ? 'pending' : null,
      finishedAt: new Date(),
    })
    .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)));
}

async function finish(
  db: Db,
  c: CallRow,
  prep: (Pick<Prepared, 'person'> & Partial<Pick<Prepared, 'def' | 'version' | 'model'>>) | null,
  out: Parameters<typeof finishIn>[3],
) {
  await db.withWorkspace(c.workspaceId, (tx) => finishIn(tx, c, prep, out));
}

/**
 * A crashed attempt may have left its budget hold on this row (#941). Move that hold to estimated
 * usage before the retry reserves again, so a retry never holds twice: the provider may already
 * have billed that attempt, and releasing it would free budget it spent. The estimate becomes the
 * row's base usage; the retry's own tokens are added to it when it settles.
 */
export async function settleStaleReservation(db: Db, c: CallRow): Promise<CallRow> {
  if (!c.reservationId) return c;
  return db.withWorkspace(c.workspaceId, async (tx) => {
    const [first] = await tx
      .select({ providerId: schema.aiTokenReservations.providerId })
      .from(schema.aiTokenReservations)
      .where(eq(schema.aiTokenReservations.id, c.reservationId!));
    if (first) {
      await lockBudget(tx, first.providerId);
      const [live] = await tx
        .select({ tokens: schema.aiTokenReservations.tokens, providerId: schema.aiTokenReservations.providerId })
        .from(schema.aiTokenReservations)
        .where(eq(schema.aiTokenReservations.id, c.reservationId!));
      if (live) {
        // A crashed attempt may have been billed: keep its hold as estimated usage, attribute it to
        // the provider, and persist the provider on the row so budget reads see it (#941 review).
        await tx
          .update(schema.aiCalls)
          .set({
            reservationId: null,
            providerId: sql`coalesce(${schema.aiCalls.providerId}, ${live.providerId})`,
            inputTokens: sql`${schema.aiCalls.inputTokens} + ${live.tokens}`,
            usageEstimated: true,
            billedAt: sql`coalesce(${schema.aiCalls.billedAt}, now())`,
          })
          .where(
            and(
              eq(schema.aiCalls.workspaceId, c.workspaceId),
              eq(schema.aiCalls.id, c.id),
              eq(schema.aiCalls.reservationId, c.reservationId!),
            ),
          );
        await tx
          .update(schema.aiTokenReservations)
          .set({ estimatedTokens: live.tokens })
          .where(eq(schema.aiTokenReservations.id, c.reservationId!));
      } else {
        await tx
          .update(schema.aiCalls)
          .set({ reservationId: null })
          .where(
            and(
              eq(schema.aiCalls.workspaceId, c.workspaceId),
              eq(schema.aiCalls.id, c.id),
              eq(schema.aiCalls.reservationId, c.reservationId!),
            ),
          );
      }
    } else {
      // The original attempt settled first: its usage is already on the row. Reload instead of
      // returning the stale claim snapshot, which would overwrite that usage (#941 review).
      await tx
        .update(schema.aiCalls)
        .set({ reservationId: null })
        .where(
          and(
            eq(schema.aiCalls.workspaceId, c.workspaceId),
            eq(schema.aiCalls.id, c.id),
            eq(schema.aiCalls.reservationId, c.reservationId!),
          ),
        );
    }
    const [fresh] = await tx
      .select()
      .from(schema.aiCalls)
      .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)));
    return fresh ?? { ...c, reservationId: null };
  });
}

/** Reserve for one step with the billing-period hold, not the five-minute default (#941). */
const reserveForStep = (db: Db, workspaceId: string, providerId: string, tokens: number) =>
  reserveTokens(db, workspaceId, providerId, tokens, billingReservationTtlMs());

/** Tie the hold to its ai_calls row, with its provider, so a retry can settle a crashed hold. */
export async function rememberReservation(db: Db, c: CallRow, reservationId: string, providerId: string): Promise<boolean> {
  try {
    const linked = await db.withWorkspace(c.workspaceId, async (tx) => {
      const rows = await tx
        .update(schema.aiCalls)
        .set({ reservationId, providerId, status: 'running' })
        .where(
          and(
            eq(schema.aiCalls.workspaceId, c.workspaceId),
            eq(schema.aiCalls.id, c.id),
            // Fence: an attempt whose lease expired must not pull a completed retry back to
            // running. Only the attempt that still owns a running row may link its hold (#941
            // round 3).
            eq(schema.aiCalls.attempts, c.attempts),
            eq(schema.aiCalls.status, 'running'),
          ),
        )
        .returning({ id: schema.aiCalls.id });
      return rows.length > 0;
    });
    if (!linked)
      await releaseTokens(db, c.workspaceId, reservationId).catch((err) =>
        logger.error({ err, callId: c.id }, 'AI budget reservation could not be released after losing the attempt fence'),
      );
    return linked;
  } catch (err) {
    // Without the row link a retry cannot find the hold; release it now rather than leak it.
    await releaseTokens(db, c.workspaceId, reservationId).catch((releaseErr) =>
      logger.error({ err: releaseErr, callId: c.id }, 'AI budget reservation could not be released after a failed row link'),
    );
    throw err;
  }
}

/** Settle a step's usage and release its hold in one locked transaction. */
async function settleStep(
  db: Db,
  c: CallRow,
  reservationId: string,
  providerId: string,
  write: (tx: Tx) => Promise<void>,
  usage: { inputTokens: number; outputTokens: number },
  label: string,
) {
  const outcome = await settleReservation(db, c.workspaceId, reservationId, write, {
    providerId,
    label,
    callId: c.id,
    usage,
  });
  if (outcome === 'held')
    logger.error(
      { workspaceId: c.workspaceId, callId: c.id, label },
      'AI step usage could not be recorded; the budget hold is kept through the billing period',
    );
  return outcome;
}

const usageFromErrorOrEstimate = (err: unknown, estimate: number, maxOutput: number) => {
  const known = usageOfError(err);
  return known ? { ...known, usageEstimated: false } : { ...estimatedUsage(estimate, maxOutput), usageEstimated: true };
};

async function handle(db: Db, c: CallRow, deps: AiStepDeps) {
  c = await settleStaleReservation(db, c);
  const prep = await db.withWorkspace(c.workspaceId, (tx) => prepare(tx, c, deps));
  if (!prep) return finish(db, c, null, { status: 'failed', error: 'no_prompt: the prompt has no published version' });
  if (prep.fallback || !prep.model || !prep.person) return finish(db, c, prep, { status: 'fallback', error: prep.fallback });
  if (prep.cache?.slots)
    return finish(db, c, prep, {
      status: 'done',
      slots: prep.cache.slots,
      output: { slots: prep.cache.slots, cached: true },
      cached: true,
    });
  const estimate = estimateTokens({ def: prep.def, person: prep.person }, prep.def.maxOutputTokens);
  let reservation: string;
  try {
    reservation = await reserveForStep(db, c.workspaceId, prep.model.providerId, estimate);
  } catch (err) {
    if (err instanceof AiUnavailable) return finish(db, c, prep, { status: 'fallback', error: `${err.reason}: ${err.message}` });
    throw err;
  }
  if (!(await rememberReservation(db, c, reservation, prep.model.providerId))) return;
  const started = Date.now();
  let out: Parameters<typeof finishIn>[3];
  try {
    const r = await runPrompt(prep.model, prep.def, prep.person, { timeoutMs: 60_000 });
    const usage = { ...r.usage, latencyMs: Date.now() - started };
    if (r.kind === 'decide') {
      out = { status: 'done', option: r.option, rationale: r.rationale, output: { option: r.option }, ...usage };
    } else {
      const rejected = Object.entries(r.rejected).map(([k, v]) => `${k}: ${v}`);
      // Only text that passed every check is worth reusing. A cache write is best effort: the
      // model has been billed, so its usage must settle even when caching fails.
      if (prep.cache && prep.def.cache && !rejected.length)
        await db
          .withWorkspace(c.workspaceId, (tx) =>
            tx
              .insert(schema.aiTextCache)
              .values({
                workspaceId: c.workspaceId,
                promptId: c.promptId ?? '',
                promptVersion: prep.version,
                cacheKey: prep.cache!.key,
                slots: r.slots,
                expiresAt: new Date(Date.now() + prep.def.cache!.ttlHours * 3_600_000),
              })
              .onConflictDoUpdate({
                target: [
                  schema.aiTextCache.workspaceId,
                  schema.aiTextCache.promptId,
                  schema.aiTextCache.promptVersion,
                  schema.aiTextCache.cacheKey,
                ],
                set: {
                  slots: r.slots,
                  createdAt: new Date(),
                  expiresAt: new Date(Date.now() + prep.def.cache!.ttlHours * 3_600_000),
                },
              }),
          )
          .catch((err) => logger.error({ err, callId: c.id }, 'AI text cache write failed; the call still settles'));
      out = {
        status: 'done',
        slots: r.slots,
        output: { slots: r.slots, rejected: r.rejected },
        error: rejected.length ? `fallback text for ${rejected.join('; ')}` : undefined,
        ...usage,
      };
    }
  } catch (err) {
    // The provider may have billed a call that threw before it returned an answer; recover its
    // usage from the error, or settle the reserved estimate rather than zero (#941).
    out = {
      status: 'fallback',
      error: modelErrorText(err),
      latencyMs: Date.now() - started,
      ...usageFromErrorOrEstimate(err, estimate, prep.def.maxOutputTokens),
    };
  }
  await settleStep(
    db,
    c,
    reservation,
    prep.model.providerId,
    (tx) => finishIn(tx, c, prep, out),
    { inputTokens: out.inputTokens ?? 0, outputTokens: out.outputTokens ?? 0 },
    'AI step',
  );
}

/** The `error` of a failed AI call: redacted while it is complete, then cut (#885). */
export function modelErrorText(err: unknown): string {
  return `model_error: ${safeErrorText(err instanceof Error ? err.message : String(err), 500)}`;
}

/** Row writers for the test/classify workers: settlement adds to a crashed attempt's estimate. */
function rowRecorder(db: Db, c: CallRow) {
  const recordIn = async (tx: Tx, values: Partial<CallRow>): Promise<void> => {
    const { inputTokens, outputTokens, usageEstimated, ...rest } = values;
    const owns = await ownsAttempt(tx, c);
    if (owns === null) return;
    if (!owns) {
      await addUsageOnly(tx, c, { inputTokens, outputTokens, usageEstimated, providerId: rest.providerId });
      return;
    }
    await tx
      .update(schema.aiCalls)
      .set({
        ...rest,
        leaseUntil: null,
        finishedAt: new Date(),
        billedAt: sql`coalesce(${schema.aiCalls.billedAt}, now())`,
        reservationId: null,
        // SQL addition, not a value computed from the claim snapshot (#941 review).
        inputTokens: sql`${schema.aiCalls.inputTokens} + ${inputTokens ?? 0}`,
        outputTokens: sql`${schema.aiCalls.outputTokens} + ${outputTokens ?? 0}`,
        usageEstimated: sql`${schema.aiCalls.usageEstimated} OR ${usageEstimated === true || c.usageEstimated}`,
      })
      .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)));
  };
  return {
    recordIn,
    record: (values: Partial<CallRow>) => db.withWorkspace(c.workspaceId, (tx) => recordIn(tx, values)),
  };
}

/** One queued prompt test case (prompts.test): run outside any transaction, then recorded. */
async function handleTest(db: Db, c: CallRow, deps: AiStepDeps) {
  c = await settleStaleReservation(db, c);
  const { record, recordIn } = rowRecorder(db, c);
  const index = Number((c.input as { index?: number }).index);
  const ready = await db.withWorkspace(c.workspaceId, async (tx) => {
    const p = await promptVersion(tx, c.promptId ?? '', c.promptVersion ?? undefined);
    const test = p?.def.tests[index];
    if (!p || !test) return null;
    try {
      return { def: p.def, test, model: await modelFor(tx, deps.kp, 'journeys', p.def.model) };
    } catch (err) {
      if (err instanceof AiUnavailable) return { error: `${err.reason}: ${err.message}` };
      throw err;
    }
  });
  if (!ready) return record({ status: 'failed', error: 'the prompt version or test case is gone' });
  if ('error' in ready) return record({ status: 'failed', error: ready.error ?? null });
  const estimate = estimateTokens({ def: ready.def, test: ready.test }, ready.def.maxOutputTokens);
  let reservation: string;
  try {
    reservation = await reserveForStep(db, c.workspaceId, ready.model.providerId, estimate);
  } catch (err) {
    if (err instanceof AiUnavailable) return record({ status: 'failed', error: `${err.reason}: ${err.message}` });
    throw err;
  }
  if (!(await rememberReservation(db, c, reservation, ready.model.providerId))) return;
  const started = Date.now();
  const r = await runTestCase(ready.model, ready.def, ready.test, { reservedTokens: estimate });
  await settleStep(
    db,
    c,
    reservation,
    ready.model.providerId,
    (tx) =>
      recordIn(tx, {
        status: r.problems.length ? 'failed' : 'done',
        providerId: ready.model.providerId,
        model: ready.model.modelId,
        input: { ...c.input, person: r.person },
        output: r.answer,
        error: r.problems.length ? safeErrorText(r.problems.join('; '), 1000) : null,
        ...r.usage,
        usageEstimated: r.estimated,
        latencyMs: Date.now() - started,
      }),
    { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
    'AI test',
  );
}

/** One ai.classify call: label the text, store the label on the person if the prompt says so. */
async function handleClassify(db: Db, c: CallRow, deps: AiStepDeps) {
  c = await settleStaleReservation(db, c);
  const { record, recordIn } = rowRecorder(db, c);
  const ready = await db.withWorkspace(c.workspaceId, async (tx) => {
    const p = await promptVersion(tx, c.promptId ?? '', c.promptVersion ?? undefined);
    if (p?.def.kind !== 'classify') return { error: 'no_prompt: the classify prompt version is gone' };
    if (c.profileId) {
      const consent = await aiAllowed(tx, c.workspaceId, c.profileId);
      if (!consent.ok) return { error: consent.reason ?? 'no_lawful_basis' };
    }
    try {
      return { def: p.def, model: await modelFor(tx, deps.kp, 'journeys', p.def.model) };
    } catch (err) {
      if (err instanceof AiUnavailable) return { error: `${err.reason}: ${err.message}` };
      throw err;
    }
  });
  if ('error' in ready) return record({ status: 'failed', error: ready.error ?? null });
  const text = String((c.input as { text?: string }).text ?? '');
  const estimate = estimateTokens({ def: ready.def, text }, ready.def.maxOutputTokens);
  let reservation: string;
  try {
    reservation = await reserveForStep(db, c.workspaceId, ready.model.providerId, estimate);
  } catch (err) {
    if (err instanceof AiUnavailable) return record({ status: 'failed', error: `${err.reason}: ${err.message}` });
    throw err;
  }
  if (!(await rememberReservation(db, c, reservation, ready.model.providerId))) return;
  const started = Date.now();
  let out: Parameters<typeof recordIn>[1];
  let r: Awaited<ReturnType<typeof runClassify>> | undefined;
  try {
    r = await runClassify(ready.model, ready.def, text, { timeoutMs: 60_000 });
  } catch (err) {
    out = {
      status: 'failed',
      error: modelErrorText(err),
      latencyMs: Date.now() - started,
      ...usageFromErrorOrEstimate(err, estimate, ready.def.maxOutputTokens),
    };
  }
  if (r) {
    try {
      let trait: string | null = null;
      const calledFor = c.profileId;
      if (ready.def.trait && calledFor)
        trait = await db.withWorkspace(c.workspaceId, async (tx) => {
          // Like a journey's updateProfile step: never into a trait the tracking plan marks personal.
          const plan = await publishedSingleton(tx, 'tracking_plan');
          const def = plan?.traits.find((x) => x.name === ready.def.trait);
          if (def && def.pii !== 'none') return null;
          // A merge can have moved the call's person since it was queued. Follow `merged_into` in
          // SQL only, and never write a trait back onto a folded-away profile (`merged_into IS
          // NULL`); an erased person has no row at all.
          const person = await canonicalProfile(tx, c.workspaceId, calledFor);
          if (!person) return null;
          await tx.execute(sql`
            UPDATE profiles SET traits = jsonb_set(traits, ARRAY[${ready.def.trait}], ${JSON.stringify(r!.label)}::jsonb), updated_at = now()
            WHERE workspace_id = ${c.workspaceId} AND id = ${person.id} AND merged_into IS NULL`);
          return ready.def.trait ?? null;
        });
      out = {
        status: 'done',
        providerId: ready.model.providerId,
        model: ready.model.modelId,
        output: { label: r.label, ...(trait ? { trait } : {}) },
        rationale: r.rationale,
        ...r.usage,
        usageEstimated: false,
        latencyMs: Date.now() - started,
        reviewStatus: sampled(ready.def) ? 'pending' : null,
      };
    } catch (err) {
      // The model was billed even though storing its label failed.
      out = {
        status: 'failed',
        providerId: ready.model.providerId,
        model: ready.model.modelId,
        error: modelErrorText(err),
        ...r.usage,
        usageEstimated: false,
        latencyMs: Date.now() - started,
      };
    }
  }
  await settleStep(
    db,
    c,
    reservation,
    ready.model.providerId,
    (tx) => recordIn(tx, out!),
    { inputTokens: out!.inputTokens ?? 0, outputTokens: out!.outputTokens ?? 0 },
    'AI classify',
  );
}

/**
 * One journey decision step: ask the decision provider its typed question about the person's
 * non-personal state, wake the participant with the probability, and store the score.
 */
async function handleScore(db: Db, c: CallRow, deps: AiStepDeps) {
  const raw = c.input as {
    questions?: unknown;
    answer?: unknown;
    scoreKey?: unknown;
    ttlHours?: unknown;
    trigger?: { name?: unknown } | null;
  };
  const parsed = decisionQuestions.safeParse(raw.questions);
  if (!parsed.success) {
    const problem = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return finish(db, c, null, { status: 'fallback', error: `invalid_questions: ${problem}` });
  }
  const questions = parsed.data as DecisionQuestion[];
  const scoreKey = typeof raw.scoreKey === 'string' ? raw.scoreKey : questions[0].key;
  const ready = await db.withWorkspace(c.workspaceId, async (tx) => {
    if (c.profileId) {
      const consent = await aiAllowed(tx, c.workspaceId, c.profileId);
      if (!consent.ok) return { error: consent.reason ?? 'no_lawful_basis' };
    }
    try {
      const provider = await decisionProvider(tx, deps.kp);
      if (!c.profileId) return { error: 'no_profile: a decision step needs a person' };
      const triggerName = typeof raw.trigger?.name === 'string' ? raw.trigger.name : undefined;
      const state = await nonPersonalState(tx, c.workspaceId, deps.events, c.profileId, triggerName ? { trigger: triggerName } : undefined);
      if (!state) return { error: 'no_profile: the person does not exist (or was erased)' };
      return { provider, state };
    } catch (err) {
      if (err instanceof AiUnavailable || err instanceof DecisionError) return { error: `${err.message}` };
      throw err;
    }
  });
  if ('error' in ready) return finish(db, c, null, { status: 'fallback', error: ready.error });
  // A choice routes on the probability of the configured label, not on whichever label won.
  const done = (r: Awaited<ReturnType<typeof decisionCall>>): Parameters<typeof finishIn>[3] => {
    const first = r.answers[0];
    const answer = typeof raw.answer === 'string' ? raw.answer : undefined;
    let routed: DecisionAnswer | undefined = first;
    if (first?.type === 'choice' && answer) {
      const p = Object.hasOwn(first.probabilities, answer) ? first.probabilities[answer] : 0;
      // The stored value must be the probability the journey routed on (#350).
      routed = { ...first, probability: p };
    }
    return {
      status: 'done',
      probability: routed?.probability,
      output: { answers: r.answers },
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      providerId: ready.provider.providerId,
      model: r.modelVersion,
      // Committed before the participant is woken, in the same transaction (#351).
      ...(c.profileId && routed
        ? {
            storeScore: {
              profileId: c.profileId,
              key: scoreKey,
              answer: routed,
              model: ready.provider.model,
              modelVersion: r.modelVersion,
              callId: c.id,
              ttlHours: typeof raw.ttlHours === 'number' ? raw.ttlHours : 168,
            },
          }
        : {}),
    };
  };
  // Record the state hash, never the raw state, in the call row beside the question and threshold.
  const call = {
    ...c,
    input: {
      ...c.input,
      stateHash: stateHash(ready.state),
      stateTokens: Math.ceil(JSON.stringify(ready.state ?? null).length / 4),
    },
  };
  /** decisionCall settled the failed row itself (with its usage); do not overwrite it. */
  let failureRecorded = false;
  try {
    await decisionCall(db, c.workspaceId, ready.provider, ready.state, questions, {
      egress: deps.egress,
      // The answer, the score and the wakeup commit in the transaction that releases the
      // reservation (#355). A late or erased step still records the tokens it was billed for;
      // only the score is withheld.
      record: (tx, r) => finishIn(tx, call, null, done(r)),
      // If that transaction fails, record provider-attributed usage and wake the fallback in one
      // transaction, without a score or second provider call. It must not wait for node timeout.
      recordUsage: (r) =>
        db.withWorkspace(c.workspaceId, (tx) =>
          finishIn(tx, call, null, {
            status: 'fallback',
            error: 'usage_recorded: the step outcome could not be stored',
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
            providerId: ready.provider.providerId,
            model: r.modelVersion,
          }),
        ),
      // A provider that answered before throwing may have billed the call; settle its usage or the
      // reserved estimate instead of recording zero (#941).
      recordFailure: (tx, usage, error, estimated) =>
        finishIn(tx, call, null, {
          status: 'fallback',
          error,
          ...usage,
          usageEstimated: estimated,
          providerId: ready.provider.providerId,
          model: ready.provider.model,
        }).then(() => {
          failureRecorded = true;
        }),
    });
  } catch (err) {
    return failureRecorded ? undefined : finish(db, c, null, { status: 'fallback', error: modelErrorText(err) });
  }
}

/** Claims due AI steps across workspaces and answers them, a few at a time. Returns how many it handled. */
export async function answerSteps(db: Db, deps: AiStepDeps, opts: { batch?: number } = {}): Promise<number> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM ai_calls
     WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND (participant_id IS NOT NULL OR kind IN ('test', 'classify')) LIMIT 100`,
  );
  let handled = 0;
  for (const { workspace_id: ws } of rows) {
    const claimed = await db.withWorkspace(ws, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE ai_calls SET status = 'running', lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = attempts + 1
        WHERE workspace_id = ${ws} AND id IN (
          SELECT id FROM ai_calls
          WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND (participant_id IS NOT NULL OR kind IN ('test', 'classify'))
          ORDER BY created_at LIMIT ${opts.batch ?? 8} FOR UPDATE SKIP LOCKED)
        RETURNING id`);
      if (!res.rows.length) return [];
      return tx
        .select()
        .from(schema.aiCalls)
        .where(
          inArray(
            schema.aiCalls.id,
            res.rows.map((r) => r.id),
          ),
        );
    });
    await Promise.all(
      claimed.map((c) =>
        (c.attempts > 3
          ? settleStaleReservation(db, c).then((clean) => finish(db, clean, null, { status: 'failed', error: 'gave up after 3 attempts' }))
          : c.kind === 'test'
            ? handleTest(db, c, deps)
            : c.kind === 'classify'
              ? handleClassify(db, c, deps)
              : c.kind === 'score'
                ? handleScore(db, c, deps)
                : handle(db, c, deps)
        ).catch((err) => logger.error({ err, call: c.id }, 'AI step failed')),
      ),
    );
    handled += claimed.length;
  }
  return handled;
}

export async function runAiWorker(db: Db, deps: AiStepDeps, signal: AbortSignal) {
  while (!signal.aborted) {
    let handled = 0;
    try {
      handled = await answerSteps(db, deps);
    } catch (err) {
      logger.error({ err }, 'AI worker round failed');
    }
    if (!handled) await new Promise((r) => setTimeout(r, 250));
  }
}
