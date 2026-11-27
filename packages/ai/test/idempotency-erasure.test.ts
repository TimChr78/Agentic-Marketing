import { createExecutor, userPrincipal } from '@agentic-marketing/commands';
import { newId } from '@agentic-marketing/core';
import { createDb, schema } from '@agentic-marketing/db';
import { disposeErasure, eraseProfileStage, prepareErasure } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { classification } from '../src/classify';
import { listAiCalls } from '../src/commands';
import { profileScores, score } from '../src/score';
import { fakeSystemOne } from '../src/testing';

// #1300: an idempotent REST request stores the command's whole answer for 30 days. A profile-bound
// AI answer (a score, a queued classification) could therefore still be replayed after the person
// was erased: the retry returned the cached score before any handler could check the profile. A
// replay of such a command now re-reads the person's gate in the replay's own transaction.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let db: ReturnType<typeof createDb>;
let kp: ReturnType<typeof localKeyProvider>;
let decision: Awaited<ReturnType<typeof fakeSystemOne>>;
let ws: string;
const providerId = `aip_${'9'.repeat(32)}`;
const MASTER_KEY = Buffer.alloc(32, 67).toString('base64');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_idempotency_erasure');
  // The executor's transaction and the command's own write share the pool.
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 6 });
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
  decision = await fakeSystemOne(() => ({ answers: { propensity: { type: 'noul', noul: 0.8 } } }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake decisions', 'decision', $3, '{"default":"jev-test-1.0.0"}'::jsonb, ARRAY['decisions'], '', '\\x00'::bytea, 'k_test')`,
    [ws, providerId, decision.baseUrl],
  );
}, 180_000);

afterAll(async () => {
  await decision?.close();
  await db?.close();
  await d?.close();
});

async function seedPerson() {
  const id = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: id,
      purpose: 'ai_processing',
      channel: '',
      status: 'granted',
      basis: 'consent',
      source: 'form',
      updatedAt: new Date(),
    });
  });
  return id;
}

const executor = () =>
  createExecutor(db, {
    serverVersion: 'test',
    strictInputs: false,
    db,
    keyProvider: kp,
    events: { eventsOf: async () => [] },
    egress: { allowedHosts: ['127.0.0.1'] },
  } as never);

const input = (profileId: string) => ({
  profileId,
  questions: [{ key: 'propensity', type: 'noul' as const, instructions: 'Will this person convert?' }],
  store: { key: 'propensity' },
});

const principal = () => userPrincipal('usr_idem', ws, 'owner');

/** Runs the erasure's SQL stage, the same one a person's erasure runs. */
async function erase(person: string) {
  const prepared = await prepareErasure(db, ws, kp);
  try {
    await db.withWorkspace(ws, (tx) =>
      eraseProfileStage(tx, { workspaceId: ws, profileId: person, requestedBy: 'user_test', reason: 'test erasure', prepared }),
    );
  } finally {
    disposeErasure(prepared);
  }
}

/** One settled AI call for the person, as the log commands read it. */
async function seedCall(person: string, kind: 'decide' | 'classify', rationale: string) {
  const id = newId('aic');
  await d.db.withWorkspace(ws, (tx) =>
    tx.insert(schema.aiCalls).values({
      workspaceId: ws,
      id,
      kind,
      status: 'done',
      profileId: person,
      input: { text: 'redacted' },
      output: kind === 'classify' ? { label: 'interested' } : { answers: [] },
      rationale,
    }),
  );
  return id;
}

describe.skipIf(!hasTestDatabase())('an idempotent answer does not outlive the person (#1300)', () => {
  it('refuses a replay of a stored score after the person was erased', async () => {
    const person = await seedPerson();
    const key = `erased-${person}`;
    const first = await executor().execute(score, input(person), principal(), { surface: 'rest', idempotencyKey: key });
    expect(first.stored).toMatchObject({ profileId: person, key: 'propensity' });

    const prepared = await prepareErasure(db, ws, kp);
    try {
      await db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, { workspaceId: ws, profileId: person, requestedBy: 'user_test', reason: 'test erasure', prepared }),
      );
    } finally {
      disposeErasure(prepared);
    }

    // The retry presents the same key and the same input: without a replay gate it would answer the
    // stored score, which is a score for a person who no longer exists.
    const replay = await executor()
      .execute(score, input(person), principal(), { surface: 'rest', idempotencyKey: key })
      .catch((err: { code?: string; message?: string }) => err);
    expect(replay).toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(replay)).not.toContain('propensity');
    expect(JSON.stringify(replay)).not.toContain('0.8');
    // Nothing was recomputed or re-stored either.
    const rows = await db.admin.query('SELECT 1 FROM profile_scores WHERE workspace_id = $1 AND profile_id = $2', [ws, person]);
    expect(rows.rowCount).toBe(0);
  }, 120_000);

  it('still replays the stored answer while the person exists', async () => {
    const person = await seedPerson();
    const key = `alive-${person}`;
    const first = await executor().execute(score, input(person), principal(), { surface: 'rest', idempotencyKey: key });
    const replay = await executor().execute(score, input(person), principal(), { surface: 'rest', idempotencyKey: key });
    expect(replay.callId).toBe(first.callId);
    expect(replay.stored).toMatchObject({ profileId: person });
  }, 120_000);

  it('replays the empty score list for an ID that has never existed', async () => {
    // An unknown profile answers `{ scores: [] }`, which holds no person data. Checking whether the
    // profile exists would turn that first (fine) answer into a 404 on the replay.
    const profileId = newId('prf');
    const opts = { surface: 'rest' as const, idempotencyKey: `missing-${profileId}` };
    const exec = executor();
    expect(await exec.execute(profileScores, { profileId }, principal(), opts)).toEqual({ scores: [] });
    expect(await exec.execute(profileScores, { profileId }, principal(), opts)).toEqual({ scores: [] });
  }, 120_000);

  it('refuses a replay of the call log after the person was erased', async () => {
    const person = await seedPerson();
    const callId = await seedCall(person, 'decide', 'Ada is likely to convert');
    const opts = { surface: 'rest' as const, idempotencyKey: `calls-${person}` };
    const first = await executor().execute(listAiCalls, { profileId: person }, principal(), opts);
    expect(first.calls.map((c) => c.id)).toEqual([callId]);
    expect(first.calls[0]!.rationale).toContain('Ada');

    await erase(person);

    // The cached log answers for a person who no longer exists, and the call rows are gone with
    // the person. The retry must not hand the stored rationale back.
    const replay = await executor()
      .execute(listAiCalls, { profileId: person }, principal(), opts)
      .catch((err: { code?: string; message?: string }) => err);
    expect(replay).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(replay)).not.toContain('Ada is likely');
  }, 120_000);

  it('still replays the call log while the person exists', async () => {
    const person = await seedPerson();
    const callId = await seedCall(person, 'decide', 'Enough signal');
    const opts = { surface: 'rest' as const, idempotencyKey: `calls-alive-${person}` };
    const first = await executor().execute(listAiCalls, { profileId: person }, principal(), opts);
    const replay = await executor().execute(listAiCalls, { profileId: person }, principal(), opts);
    expect(replay.calls.map((c) => c.id)).toEqual([callId]);
    expect(replay).toEqual(first);
  }, 120_000);

  it('refuses a replay of a classification after the person was erased', async () => {
    const person = await seedPerson();
    const callId = await seedCall(person, 'classify', 'The reply asks for a refund');
    const opts = { surface: 'rest' as const, idempotencyKey: `classification-${callId}` };
    const first = await executor().execute(classification, { callId }, principal(), opts);
    expect(first).toMatchObject({ status: 'done', label: 'interested', traitSet: null });

    await erase(person);

    const replay = await executor()
      .execute(classification, { callId }, principal(), opts)
      .catch((err: { code?: string; message?: string }) => err);
    expect(replay).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(replay)).not.toContain('refund');
  }, 120_000);
});
