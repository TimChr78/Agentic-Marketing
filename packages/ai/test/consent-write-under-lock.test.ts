import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { storeProfileScore } from '../src/decision';
import { finishIn, storeClassifiedTrait } from '../src/steps';
import { blockedBy, waitFor } from './raceSupport';

// #1300: the two score writers and the classify trait write checked AI consent before they took
// the profile lock, so a consent change that committed in between was not seen: a score or a label
// could be written for a person who had objected. Each write must re-read the gate under the lock
// it writes behind. The classifier's write additionally takes the workspace identity lock first,
// because a standalone consent writer serialises on that lock rather than on the profile row.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 9, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_consent_write_lock');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function seedProfile(id: string) {
  await d.db.withWorkspace(ws, (tx) => tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt: new Date(at()) }));
}

async function grantAi(id: string) {
  await d.db.withWorkspace(ws, (tx) =>
    tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: id,
      purpose: 'ai_processing',
      channel: '',
      status: 'granted',
      basis: 'consent',
      source: 'form',
      updatedAt: new Date(at()),
    }),
  );
}

/** A second connection that holds a lock and changes the person's consent, then waits to commit. */
async function withheldConsentChange(personId: string, lock: 'profile' | 'identity') {
  const probe = await d.db.admin.connect();
  await probe.query('BEGIN');
  if (lock === 'identity') await probe.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`identity:${ws}`]);
  else await probe.query('SELECT id FROM profiles WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [ws, personId]);
  await probe.query(
    `UPDATE consent_state SET status = 'objected', basis = 'legitimate_interest', updated_at = now()
     WHERE workspace_id = $1 AND profile_id = $2 AND purpose = 'ai_processing'`,
    [ws, personId],
  );
  const pid = (await probe.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let done = false;
  return {
    conn: probe,
    pid,
    async commit() {
      await probe.query('COMMIT');
      done = true;
      probe.release();
    },
    async drop() {
      if (done) return;
      done = true;
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    },
  };
}

const answer = { key: 'propensity', type: 'noul' as const, probability: 0.8, probabilities: { true: 0.8, false: 0.2 } };

const scoreRows = async (key: string) =>
  (await d.db.admin.query<{ profile_id: string }>('SELECT profile_id FROM profile_scores WHERE workspace_id = $1 AND key = $2', [ws, key]))
    .rows;

const traitOf = async (personId: string) =>
  (
    await d.db.admin.query<{ trait: string | null }>(
      `SELECT traits->>'reply_intent' AS trait FROM profiles WHERE workspace_id = $1 AND id = $2`,
      [ws, personId],
    )
  ).rows[0]?.trait;

describe.skipIf(!hasTestDatabase())('a score write re-checks consent under the profile lock (#1300)', () => {
  it('withholds the standalone score when consent changed while the write waited', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const held = await withheldConsentChange(person, 'profile');
    try {
      const pending = storeProfileScore(d.db, ws, {
        profileId: person,
        key: 'under_lock',
        answer,
        model: 'test-model',
        modelVersion: 'v1',
        callId: null,
        ttlHours: 168,
      });
      // A write that does not wait for the profile row would store the score while the objection
      // is still uncommitted, so the race is only real when both touch the same row.
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the score write to wait for the held profile row', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      expect(await pending).toBeNull();
    } finally {
      await held.drop();
    }
    expect(await scoreRows('under_lock')).toEqual([]);
  }, 60_000);

  it('takes the fallback edge when a journey decision finds the objection under its lock', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const [participant] = await d.db.withWorkspace(ws, (tx) =>
      tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: 'decide',
          seq: 1,
          status: 'waiting',
          dueAt: new Date(Date.UTC(2026, 9, 2)),
        })
        .returning({ id: schema.journeyParticipants.id }),
    );
    const callId = newId('aic');
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id: callId,
        kind: 'score',
        status: 'running',
        attempts: 1,
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId: person,
        // What the decision step stores once the state is built: a hash and its size, never the
        // state itself, and the event that started the step with its properties.
        input: {
          questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
          stateHash: 'hash-of-the-person-state',
          stateTokens: 1234,
          trigger: { name: 'Order Completed', properties: { email: 'ada@example.com' } },
        },
      }),
    );
    const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));
    const held = await withheldConsentChange(person, 'profile');
    try {
      const pending = d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call!, null, {
          status: 'done',
          probability: answer.probability,
          output: { answers: [answer] },
          // What the provider answered with, which must not survive a refusal.
          model: 'provider-reported-9.1',
          configuredModel: 'test-model',
          storeScore: {
            profileId: person,
            key: 'journey_lock',
            answer,
            model: 'test-model',
            modelVersion: 'v1',
            callId: call!.id,
            ttlHours: 168,
          },
        }),
      );
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the decision write to wait for the held profile row', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      await pending;
    } finally {
      await held.drop();
    }
    expect(await scoreRows('journey_lock')).toEqual([]);
    const settled = (
      await d.db.admin.query<{
        status: string;
        error: string | null;
        model: string | null;
        input: Record<string, unknown>;
        output: unknown;
      }>('SELECT status, error, model, input, output FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId])
    ).rows[0]!;
    // The answer is recorded as a fallback so the participant takes its fallback edge. The call row
    // keeps only the fallback reason and the billing fields: the predicted probability, the state
    // hash and its estimated size, and the provider's own model version are dropped (#1300 review).
    expect(settled).toMatchObject({ status: 'fallback', output: null, model: 'test-model' });
    expect(settled.error).toContain('no_lawful_basis');
    expect(settled.input.stateHash).toBeUndefined();
    expect(settled.input.stateTokens).toBeUndefined();
    expect(JSON.stringify(settled.input)).not.toContain('ada@example.com');
    expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
    const waitingRow = (
      await d.db.admin.query<{
        status: string;
        context: { ai?: { decide?: Record<string, unknown> } };
      }>('SELECT status, context FROM journey_participants WHERE workspace_id = $1 AND id = $2', [ws, participant!.id])
    ).rows[0]!;
    expect(waitingRow.status).toBe('waiting');
    // The participant takes its fallback edge, and the prediction is not kept beside it.
    expect(waitingRow.context.ai?.decide?.fallback).toContain('no_lawful_basis');
    expect(waitingRow.context.ai?.decide?.probability).toBeUndefined();
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('a decision or generate step re-checks consent before committing the outcome (#1300)', () => {
  async function seedStep(person: string, kind: 'decide' | 'generate') {
    return d.db.withWorkspace(ws, async (tx) => {
      const [participant] = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: kind,
          seq: 1,
          status: 'waiting',
          dueAt: new Date(Date.UTC(2026, 9, 2)),
        })
        .returning({ id: schema.journeyParticipants.id });
      const callId = newId('aic');
      await tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id: callId,
        kind,
        status: 'running',
        attempts: 1,
        participantId: participant!.id,
        node: kind,
        seq: 1,
        profileId: person,
        // What a journey step records: the event that started it, properties included.
        input: { trigger: { name: 'Order Completed', properties: { email: 'ada@example.com' } } },
      });
      const [call] = await tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId));
      return { call: call!, participantId: participant!.id };
    });
  }

  /** The settled call row: what it kept of the answer and of the input. */
  const settledCall = async (callId: string) =>
    (
      await d.db.admin.query<{
        status: string;
        error: string | null;
        input_tokens: number;
        output: unknown;
        rationale: string | null;
        input: Record<string, unknown>;
      }>('SELECT status, error, input_tokens, output, rationale, input FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId])
    ).rows[0]!;

  async function holdsOnIdentityLock(pending: Promise<unknown>, held: Awaited<ReturnType<typeof withheldConsentChange>>) {
    return Promise.race([
      pending.then(() => 'settled' as const),
      waitFor('the finalisation to wait for the identity lock', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
        () => 'blocked' as const,
      ),
    ]);
  }

  async function commitAfterObjection(person: string, run: () => Promise<unknown>) {
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = run();
      expect(await holdsOnIdentityLock(pending, held)).toBe('blocked');
      await held.commit();
      await pending;
    } finally {
      await held.drop();
    }
  }

  it('does not commit a decision after the person objected while the model ran', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const { call, participantId } = await seedStep(person, 'decide');
    // The preparation that was sent to the provider: the person's context is in the call's input.
    const prep = { person: { id: person, traits: { plan: 'pro' } } };
    await commitAfterObjection(person, () =>
      d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call, prep, {
          status: 'done',
          option: 'a',
          rationale: 'Ada is likely to convert',
          output: { answers: [] },
          inputTokens: 20,
          outputTokens: 4,
        }),
      ),
    );
    const settled = await settledCall(call.id);
    // Usage is still settled: the provider was called and billed. The answer, its rationale and the
    // prepared context are not kept for a person who refused.
    expect(settled).toMatchObject({ status: 'fallback', input_tokens: 20, output: null, rationale: null });
    expect(settled.error).toContain('no_lawful_basis');
    expect(settled.input.person).toBeUndefined();
    expect(JSON.stringify(settled.input)).not.toContain('ada@example.com');
    expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
    const context = (
      await d.db.admin.query<{ context: { ai?: { decide?: Record<string, unknown> } } }>(
        'SELECT context FROM journey_participants WHERE workspace_id = $1 AND id = $2',
        [ws, participantId],
      )
    ).rows[0]!.context;
    // The participant takes its fallback edge; the decision and its rationale are not kept.
    expect(context.ai?.decide?.fallback).toContain('no_lawful_basis');
    expect(context.ai?.decide?.option).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('Ada is likely');
  }, 60_000);

  it('does not commit generated text after the person withdrew while the model ran', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const { call, participantId } = await seedStep(person, 'generate');
    const prep = { person: { id: person, traits: { plan: 'pro' } } };
    await commitAfterObjection(person, () =>
      d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call, prep, {
          status: 'done',
          slots: { subject: 'Ada, your order is ready' },
          output: { slots: { subject: 'Ada, your order is ready' } },
          inputTokens: 30,
          outputTokens: 6,
        }),
      ),
    );
    const settled = await settledCall(call.id);
    // The generated slots and the context that produced them are not kept; the tokens are.
    expect(settled).toMatchObject({ status: 'fallback', input_tokens: 30, output: null, rationale: null });
    expect(settled.input.person).toBeUndefined();
    expect(JSON.stringify(settled)).not.toContain('your order is ready');
    expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
    const context = (
      await d.db.admin.query<{ context: { content?: Record<string, unknown>; ai?: { generate?: Record<string, unknown> } } }>(
        'SELECT context FROM journey_participants WHERE workspace_id = $1 AND id = $2',
        [ws, participantId],
      )
    ).rows[0]!.context;
    // The journey fills the prompt's fallback slots itself; the model's text is not committed.
    expect(context.content?.subject).toBeUndefined();
    expect(context.ai?.generate?.fallback).toContain('no_lawful_basis');
    expect(JSON.stringify(context)).not.toContain('your order is ready');
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('a score step takes the identity lock only when it can write a score (#1300)', () => {
  it('settles a budget fallback while a consent writer holds the identity lock', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const { call } = await d.db.withWorkspace(ws, async (tx) => {
      const [participant] = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: 'decide',
          seq: 1,
          status: 'waiting',
          dueAt: new Date(Date.UTC(2026, 9, 2)),
        })
        .returning({ id: schema.journeyParticipants.id });
      const callId = newId('aic');
      await tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id: callId,
        kind: 'score',
        status: 'running',
        attempts: 1,
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId: person,
        input: { questions: [] },
      });
      const [row] = await tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId));
      return { call: row! };
    });
    // A consent writer holds the workspace identity lock. A fallback writes no person data, so the
    // step must not queue behind the lock: only a done answer (or a score) does.
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call, null, { status: 'fallback', error: 'budget: the monthly tokens are used up', inputTokens: 10, outputTokens: 0 }),
      );
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 5_000)),
      ]);
      expect(first).toBe('settled');
    } finally {
      await held.drop();
    }
    const settled = (
      await d.db.admin.query<{ status: string; error: string | null }>(
        'SELECT status, error FROM ai_calls WHERE workspace_id = $1 AND id = $2',
        [ws, call.id],
      )
    ).rows[0]!;
    expect(settled).toMatchObject({ status: 'fallback', error: 'budget: the monthly tokens are used up' });
  }, 60_000);
});

// A step that already timed out has no participant left to wake, so the score write is skipped and
// nothing re-read the gate: the answer, the state fingerprint and the provider's model version were
// stored on the call row after the person had withdrawn. Finalisation now re-checks consent under
// the locks it already holds whatever the outcome, and a refusal takes the same allowlist.
describe.skipIf(!hasTestDatabase())('a late score re-checks consent before storing the answer (#1300 review)', () => {
  it('withholds the answer when the participant already timed out and consent was withdrawn', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const [participant] = await d.db.withWorkspace(ws, (tx) =>
      tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: 'decide',
          seq: 1,
          // The node timed out while the model ran: the step is no longer waiting for an answer.
          status: 'completed',
          dueAt: new Date(Date.UTC(2026, 9, 2)),
        })
        .returning({ id: schema.journeyParticipants.id }),
    );
    const callId = newId('aic');
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id: callId,
        kind: 'score',
        status: 'running',
        attempts: 1,
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId: person,
        input: {
          questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
          stateHash: 'hash-of-the-person-state',
          stateTokens: 1234,
          trigger: { name: 'Order Completed', properties: { email: 'ada@example.com' } },
        },
      }),
    );
    const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));
    // A consent writer holds the workspace identity lock, not the profile row.
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call!, null, {
          status: 'done',
          probability: answer.probability,
          output: { answers: [answer] },
          // What the provider answered with, which must not survive a refusal.
          model: 'provider-reported-9.1',
          configuredModel: 'test-model',
          storeScore: {
            profileId: person,
            key: 'late_answer',
            answer,
            model: 'test-model',
            modelVersion: 'v1',
            callId: call!.id,
            ttlHours: 168,
          },
        }),
      );
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the late answer to wait for the identity lock', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      await pending;
    } finally {
      await held.drop();
    }
    expect(await scoreRows('late_answer')).toEqual([]);
    const settled = (
      await d.db.admin.query<{
        status: string;
        error: string | null;
        model: string | null;
        input: Record<string, unknown>;
        output: unknown;
      }>('SELECT status, error, model, input, output FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId])
    ).rows[0]!;
    // The row keeps only the fallback reason and the billing fields: the answer, the state fingerprint
    // and its size, and the provider's own model version are dropped.
    expect(settled).toMatchObject({ status: 'fallback', output: null, model: 'test-model' });
    expect(settled.error).toContain('no_lawful_basis');
    expect(settled.input.stateHash).toBeUndefined();
    expect(settled.input.stateTokens).toBeUndefined();
    expect(JSON.stringify(settled.input)).not.toContain('ada@example.com');
    expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('a failure fallback re-checks consent before storing person data (#1300 review)', () => {
  async function seedCall(kind: 'score' | 'generate', input: Record<string, unknown>) {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    const callId = newId('aic');
    await d.db.withWorkspace(ws, (tx) =>
      tx
        .insert(schema.aiCalls)
        .values({ workspaceId: ws, id: callId, kind, status: 'running', attempts: 1, node: kind, seq: 1, profileId: person, input }),
    );
    const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));
    const settled = async () =>
      (
        await d.db.admin.query<{ status: string; error: string | null; input_tokens: number; input: Record<string, unknown> }>(
          'SELECT status, error, input_tokens, input FROM ai_calls WHERE workspace_id = $1 AND id = $2',
          [ws, callId],
        )
      ).rows[0]!;
    return { person, call: call!, settled };
  }

  it('replaces a provider’s failure text with the refusal', async () => {
    // The provider failed after seeing the call; its text may quote the person it was asked about.
    const { person, call, settled } = await seedCall('score', { questions: [] });
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call, null, {
          status: 'fallback',
          error: 'model_error: Ada Lovelace <ada@example.com>',
          providerText: true,
          inputTokens: 12,
          outputTokens: 0,
        }),
      );
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the failure fallback to wait for the identity lock', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      await pending;
    } finally {
      await held.drop();
    }
    const row = await settled();
    // The tokens the provider billed are kept; its text is not.
    expect(row).toMatchObject({ status: 'fallback', input_tokens: 12 });
    expect(row.error).toContain('no_lawful_basis');
    expect(JSON.stringify(row)).not.toContain('ada@example.com');
  }, 60_000);

  it('clears the prepared context of a budget fallback', async () => {
    // Preparation succeeded, so the step carries the person's context even though the model never ran.
    const { person, call, settled } = await seedCall('generate', {
      trigger: { name: 'Order Completed', properties: { email: 'ada@example.com' } },
    });
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = d.db.withWorkspace(ws, (tx) =>
        finishIn(
          tx,
          call,
          { person: { id: person, traits: { plan: 'pro' } } },
          {
            status: 'fallback',
            error: 'budget: the monthly tokens are used up',
            inputTokens: 40,
            outputTokens: 0,
          },
        ),
      );
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the budget fallback to wait for the identity lock', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      await pending;
    } finally {
      await held.drop();
    }
    const row = await settled();
    expect(row).toMatchObject({ status: 'fallback', input_tokens: 40 });
    expect(row.error).toContain('no_lawful_basis');
    expect(row.input.person).toBeUndefined();
    expect(JSON.stringify(row.input)).not.toContain('ada@example.com');
    expect(row.input.trigger).toEqual({ name: 'Order Completed' });
  }, 60_000);
});

// A queued step carries the event that started it, properties included. When the prompt is missing
// or the participant timed out before preparation, finalisation never built the person context and
// so never whether the person still allows AI processing — it copied those properties into the
// terminal call record anyway. An exit that never built the context now strips them, keeping only
// the trigger's name; an exit that did build it is consent-gated like any other person data.
describe.skipIf(!hasTestDatabase())('a terminal exit that never built the context strips the trigger properties (#1300 review)', () => {
  const exits: Array<{
    name: string;
    prep: { person?: Record<string, unknown> } | null;
    out: { status: 'done' | 'fallback' | 'failed'; error?: string; inputTokens?: number };
    keeps?: boolean;
  }> = [
    {
      name: 'the prompt has no published version',
      prep: null,
      out: { status: 'failed', error: 'no_prompt: the prompt has no published version' },
    },
    {
      name: 'the participant timed out before preparation',
      prep: {},
      out: { status: 'fallback', error: 'too_late: the step was no longer waiting' },
    },
    {
      name: 'the step questions are invalid',
      prep: null,
      out: { status: 'fallback', error: 'invalid_questions: propensity: Required' },
    },
    {
      name: 'the step gave up after three attempts',
      prep: null,
      out: { status: 'failed', error: 'gave up after 3 attempts' },
    },
    {
      name: 'the model never ran but the context was built and the person allows AI',
      prep: { person: { traits: { plan: 'pro' } } },
      out: { status: 'fallback', error: 'budget: the monthly tokens are used up', inputTokens: 40 },
      keeps: true,
    },
  ];

  for (const exit of exits) {
    it(`keeps only the trigger name when ${exit.name}`, async () => {
      const person = newId('prf');
      await seedProfile(person);
      await grantAi(person);
      const callId = newId('aic');
      await d.db.withWorkspace(ws, (tx) =>
        tx.insert(schema.aiCalls).values({
          workspaceId: ws,
          id: callId,
          kind: 'generate',
          status: 'running',
          attempts: 1,
          node: 'generate',
          seq: 1,
          profileId: person,
          input: { trigger: { name: 'Order Completed', properties: { sample: 'synthetic-person-data' } } },
        }),
      );
      const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));

      // The person withdrew while the step was queued: neither the properties nor anything built
      // from the person may be written after that. The last case keeps its consent, which shows the
      // rule is about the context having been built, not about refusing every terminal exit.
      if (!exit.keeps) {
        const held = await withheldConsentChange(person, 'identity');
        try {
          await held.commit();
        } finally {
          await held.drop();
        }
      }
      await d.db.withWorkspace(ws, (tx) => finishIn(tx, call!, exit.prep, exit.out));

      const settled = (
        await d.db.admin.query<{ status: string; input: Record<string, unknown> }>(
          'SELECT status, input FROM ai_calls WHERE workspace_id = $1 AND id = $2',
          [ws, callId],
        )
      ).rows[0]!;
      expect(settled.status).toBe(exit.out.status);
      if (exit.keeps) {
        expect(settled.input.trigger).toEqual({ name: 'Order Completed', properties: { sample: 'synthetic-person-data' } });
        expect(settled.input.person).toEqual({ traits: { plan: 'pro' } });
      } else {
        expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
        expect(JSON.stringify(settled.input)).not.toContain('synthetic-person-data');
      }
    }, 60_000);
  }
});

describe.skipIf(!hasTestDatabase())('the classify trait write serialises with a consent change (#1300)', () => {
  it('takes the identity lock before the profile lock, so it reads the committed objection', async () => {
    const person = newId('prf');
    await seedProfile(person);
    await grantAi(person);
    // A standalone consent writer holds the workspace identity lock, not the profile row.
    const held = await withheldConsentChange(person, 'identity');
    try {
      const pending = d.db.withWorkspace(ws, (tx) => storeClassifiedTrait(tx, ws, person, 'reply_intent', 'question'));
      const first = await Promise.race([
        pending.then(() => 'settled' as const),
        waitFor('the trait write to wait for the identity lock', async () => (await blockedBy(held.conn, held.pid)).length > 0).then(
          () => 'blocked' as const,
        ),
      ]);
      expect(first).toBe('blocked');
      await held.commit();
      expect(await pending).toBeNull();
    } finally {
      await held.drop();
    }
    expect(await traitOf(person)).toBeNull();
  }, 60_000);
});
