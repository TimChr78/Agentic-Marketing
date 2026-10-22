import type { PromptDefinition } from '@agentic-marketing/artifacts';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { aiAllowed, personContext } from './context';
import { promptVersion, runPrompt } from './prompts';
import { AiUnavailable, modelFor, type ReadyModel } from './providers';

// The AI worker: answers the AI steps of journeys. A step is a pending row in ai_calls; the
// worker claims it with a lease, builds the context and checks consent in one transaction,
// calls the model outside any transaction, then stores the outcome on the participant and wakes
// it. Whatever goes wrong, the step gets a fallback with the reason, never a stuck participant.

export interface AiStepDeps {
  kp: KeyProvider;
  events: EventStore;
}

type CallRow = typeof schema.aiCalls.$inferSelect;
const LEASE_MS = 120_000;

interface Prepared {
  def: PromptDefinition;
  version: number;
  model?: ReadyModel;
  person?: Record<string, unknown>;
  fallback?: string;
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
    const trigger = (c.input as { trigger?: { name: string; properties: Record<string, unknown> } | null }).trigger ?? undefined;
    const person = await personContext(tx, c.workspaceId, deps.kp, deps.events, c.profileId ?? '', trigger);
    if (!person) return { ...base, fallback: 'no_profile: the person does not exist (or was erased)' };
    return { ...base, model, person: person as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof AiUnavailable) return { ...base, fallback: `${err.reason}: ${err.message}` };
    throw err;
  }
}

async function finish(
  db: Db,
  c: CallRow,
  prep: Prepared | null,
  out: {
    status: 'done' | 'fallback' | 'failed';
    option?: string;
    rationale?: string;
    slots?: Record<string, string>;
    output?: unknown;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  },
) {
  await db.withWorkspace(c.workspaceId, async (tx) => {
    const outcome = {
      seq: c.seq,
      ...(out.option ? { option: out.option, rationale: out.rationale ?? '' } : {}),
      ...(out.status !== 'done' ? { fallback: out.error ?? 'failed' } : {}),
    };
    // On a fallback the journey fills the slots with the prompt's fallback texts itself.
    const content = out.slots;
    // Wake the participant only if it still waits at this step; otherwise the answer came too late.
    const woke = await tx.execute(sql`
      UPDATE journey_participants SET
        context = jsonb_set(
          CASE WHEN ${content ? JSON.stringify(content) : null}::jsonb IS NULL THEN context
               ELSE jsonb_set(context, '{content}', coalesce(context->'content', '{}') || ${content ? JSON.stringify(content) : null}::jsonb) END,
          '{ai}', coalesce(context->'ai', '{}') || jsonb_build_object(${c.node}::text, ${JSON.stringify(outcome)}::jsonb)),
        due_at = now(), updated_at = now()
      WHERE workspace_id = ${c.workspaceId} AND id = ${c.participantId} AND node = ${c.node} AND seq = ${c.seq} AND status = 'waiting'`);
    const late = !woke.rowCount && out.status === 'done';
    await tx
      .update(schema.aiCalls)
      .set({
        status: late ? 'fallback' : out.status,
        leaseUntil: null,
        promptVersion: prep?.version ?? null,
        providerId: prep?.model?.providerId ?? null,
        model: prep?.model?.modelId ?? null,
        input: { ...c.input, ...(prep?.person ? { person: prep.person } : {}) },
        output: out.output ?? null,
        rationale: out.rationale ?? null,
        error: late ? 'too_late: the step had timed out and took its fallback' : (out.error ?? null),
        inputTokens: out.inputTokens ?? 0,
        outputTokens: out.outputTokens ?? 0,
        latencyMs: out.latencyMs ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(schema.aiCalls.workspaceId, c.workspaceId), eq(schema.aiCalls.id, c.id)));
  });
}

async function handle(db: Db, c: CallRow, deps: AiStepDeps) {
  const prep = await db.withWorkspace(c.workspaceId, (tx) => prepare(tx, c, deps));
  if (!prep) return finish(db, c, null, { status: 'failed', error: 'no_prompt: the prompt has no published version' });
  if (prep.fallback || !prep.model || !prep.person) return finish(db, c, prep, { status: 'fallback', error: prep.fallback });
  const started = Date.now();
  try {
    const r = await runPrompt(prep.model, prep.def, prep.person, { timeoutMs: 60_000 });
    const usage = { ...r.usage, latencyMs: Date.now() - started };
    if (r.kind === 'decide')
      return finish(db, c, prep, { status: 'done', option: r.option, rationale: r.rationale, output: { option: r.option }, ...usage });
    const rejected = Object.entries(r.rejected).map(([k, v]) => `${k}: ${v}`);
    return finish(db, c, prep, {
      status: 'done',
      slots: r.slots,
      output: { slots: r.slots, rejected: r.rejected },
      error: rejected.length ? `fallback text for ${rejected.join('; ')}` : undefined,
      ...usage,
    });
  } catch (err) {
    return finish(db, c, prep, { status: 'fallback', error: `model_error: ${(err as Error).message}`, latencyMs: Date.now() - started });
  }
}

/** Claims due AI steps across workspaces and answers them, a few at a time. Returns how many it handled. */
export async function answerSteps(db: Db, deps: AiStepDeps, opts: { batch?: number } = {}): Promise<number> {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM ai_calls
     WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND participant_id IS NOT NULL LIMIT 100`,
  );
  let handled = 0;
  for (const { workspace_id: ws } of rows) {
    const claimed = await db.withWorkspace(ws, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE ai_calls SET status = 'running', lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = attempts + 1
        WHERE workspace_id = ${ws} AND id IN (
          SELECT id FROM ai_calls
          WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND participant_id IS NOT NULL
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
        (c.attempts > 3 ? finish(db, c, null, { status: 'failed', error: 'gave up after 3 attempts' }) : handle(db, c, deps)).catch((err) =>
          logger.error({ err, call: c.id }, 'AI step failed'),
        ),
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
