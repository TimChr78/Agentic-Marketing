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
        input: {},
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
      await d.db.admin.query<{ status: string; error: string | null }>(
        'SELECT status, error FROM ai_calls WHERE workspace_id = $1 AND id = $2',
        [ws, callId],
      )
    ).rows[0]!;
    // The answer is recorded as a fallback so the participant takes its fallback edge.
    expect(settled.status).toBe('fallback');
    expect(settled.error).toContain('no_lawful_basis');
    const participantStatus = (
      await d.db.admin.query<{ status: string }>('SELECT status FROM journey_participants WHERE workspace_id = $1 AND id = $2', [
        ws,
        participant!.id,
      ])
    ).rows[0]!;
    expect(participantStatus.status).toBe('waiting');
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
