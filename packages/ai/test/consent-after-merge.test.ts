import { artifactTypes, DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch } from '@agentic-marketing/profiles';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  // Only the provider key is opened on this path; nothing else about the key provider matters here.
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { classify } from '../src/classify';
import { aiAllowed } from '../src/context';
import { consentCheckedScoreProfile, score } from '../src/score';
import { answerSteps } from '../src/steps';
import { fakeLlm, fakeSystemOne } from '../src/testing';

// A merge deletes the merged-away profile's consent_state rows, so a gate that reads consent under
// the id a caller happens to hold reads "no record" for a person who objected (and, on a consent
// basis, for a person who granted). The AI consent gate must answer for the person the id names
// today: ai.score, ai.classify and the journey AI steps all pass a possibly pre-merge id, and the
// work they then do lands on the survivor. #1281 is the journey-step side of the same mechanism.

const MASTER_KEY = Buffer.alloc(32, 65).toString('base64');
const journeyProviderId = `aip_${'7'.repeat(32)}`;
const decisionProviderId = `aip_${'8'.repeat(32)}`;
const classifyPrompt = `prm_${'c'.repeat(32)}`;
const decidePrompt = `prm_${'d'.repeat(32)}`;

type Stack = Awaited<ReturnType<typeof createDisposableDb>>;

let consentDb: Stack;
let interestDb: Stack;
let kp: ReturnType<typeof localKeyProvider>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let systemOne: Awaited<ReturnType<typeof fakeSystemOne>>;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 7, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  // Each workspace gets its own database: publishedSingleton relies on the row policy, and a
  // disposable database's app pool is its owner.
  consentDb = await createDisposableDb('ai_consent_after_merge');
  interestDb = await createDisposableDb('ai_consent_after_merge_lia');
  kp = localKeyProvider(MASTER_KEY);
  llm = await fakeLlm(() => ({
    text: JSON.stringify({ option: 'a', rationale: 'Enough signal to decide.' }),
    inputTokens: 40,
    outputTokens: 5,
  }));
  systemOne = await fakeSystemOne(() => ({ answers: { propensity: { type: 'noul', noul: 0.8 } } }));
  await consentDb.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake', 'openai-compatible', $3, '{"default":"gpt-test"}'::jsonb, ARRAY['journeys'], '', '\\x00'::bytea, 'k_test')`,
    [consentDb.workspace, journeyProviderId, llm.baseUrl],
  );
  await consentDb.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake decisions', 'decision', $3, '{"default":"jev-test-1.0.0"}'::jsonb, ARRAY['decisions'], '', '\\x00'::bytea, 'k_test')`,
    [consentDb.workspace, decisionProviderId, systemOne.baseUrl],
  );
}, 120_000);

afterAll(async () => {
  await llm?.close();
  await systemOne?.close();
  await consentDb?.close();
  await interestDb?.close();
});

const event = (workspaceId: string, over: Partial<BusEvent>): BusEvent => ({
  workspaceId,
  sourceId: 'src_ai_consent_merge',
  messageId: newId('evt'),
  type: 'track',
  name: 'Page Viewed',
  anonymousId: '',
  userId: '',
  timestamp: at(),
  receivedAt: at(),
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

async function seedProfile(
  db: Stack,
  id: string,
  idents: { anonymous?: string; user?: string },
  createdAt: Date,
  traits: Record<string, unknown> = {},
) {
  const ws = db.workspace;
  await db.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt, traits });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

/** Two profiles, the second folded into the first, as an identity merge leaves them. */
async function mergedPair(db: Stack) {
  const ws = db.workspace;
  const survivor = newId('prf');
  const alias = newId('prf');
  await seedProfile(db, survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 7, 1)), { plan: 'survivor-plan' });
  await seedProfile(db, alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 7, 2)));
  const batch = [event(ws, { anonymousId: `anon-${alias}`, userId: `user-${survivor}` })];
  await withPreparedKeys(
    async () => {
      const ids = await db.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
      return prepareKeys(db.db, ws, kp, { profileIds: ids });
    },
    (prepared) => db.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );
  return { survivor, alias };
}

async function setConsent(db: Stack, profileId: string, status: 'granted' | 'objected') {
  const ws = db.workspace;
  await db.db.withWorkspace(ws, (tx) =>
    tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId,
      purpose: 'ai_processing',
      status,
      basis: status === 'granted' ? 'consent' : 'legitimate_interest',
      source: 'api',
      updatedAt: new Date(),
    }),
  );
}

async function publish(db: Stack, id: string, type: 'purposes' | 'prompt', name: string, content: unknown) {
  const ws = db.workspace;
  await db.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({ workspaceId: ws, id, type, name, latestVersion: 1, publishedVersion: 1 });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'published',
      content,
      contentHash: 'h',
      authorType: 'user',
      authorId: 'u_test',
    });
  });
}

/** Publishes purposes whose ai_processing purpose runs on legitimate interest. */
async function publishLegitimateInterestPurposes(db: Stack) {
  const purposes = DEFAULT_PURPOSES.map((p) =>
    p.key === 'ai_processing'
      ? {
          ...p,
          basis: 'legitimate_interest' as const,
          lia: { assessment: 'Test assessment', owner: 'DPO', reviewBy: '2027-01-01' },
        }
      : p,
  );
  await publish(db, newId('pur'), 'purposes', 'Purposes', artifactTypes.purposes.content.parse({ purposes }));
}

async function publishPrompts(db: Stack) {
  await publish(
    db,
    classifyPrompt,
    'prompt',
    'Reply intent',
    artifactTypes.prompt.content.parse({
      kind: 'classify',
      instructions: 'Label the reply.',
      options: [
        { key: 'question', description: 'Asks something' },
        { key: 'other', description: 'Anything else' },
      ],
      trait: 'reply_intent',
    }),
  );
  await publish(
    db,
    decidePrompt,
    'prompt',
    'Decide',
    artifactTypes.prompt.content.parse({
      kind: 'decide',
      instructions: 'Pick one.',
      options: [
        { key: 'a', description: 'First' },
        { key: 'b', description: 'Second' },
      ],
    }),
  );
}

const gate = (db: Stack, profileId: string) => db.db.withWorkspace(db.workspace, (tx) => aiAllowed(tx, db.workspace, profileId));

const checkScoreProfile = (db: Stack, profileId: string) =>
  db.db.withWorkspace(db.workspace, (tx) => consentCheckedScoreProfile(tx, db.workspace, profileId));

const noul = { key: 'propensity', type: 'noul' as const, instructions: 'Will this person convert?' };

/** Queues one decide AI step for the person, as a journey waiting at an AI node leaves it. */
async function queueDecideStep(db: Stack, profileId: string) {
  const ws = db.workspace;
  return db.db.withWorkspace(ws, async (tx) => {
    const [participant] = await tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId: newId('jrn'),
        version: 1,
        profileId,
        entryKey: `test:${profileId}`,
        node: 'decide',
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.UTC(2026, 7, 3)),
      })
      .returning({ id: schema.journeyParticipants.id });
    const [call] = await tx
      .insert(schema.aiCalls)
      .values({
        workspaceId: ws,
        id: newId('aic'),
        kind: 'decide',
        status: 'pending',
        promptId: decidePrompt,
        promptVersion: 1,
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId,
        input: {},
      })
      .returning();
    return call!;
  });
}

const readCall = async (db: Stack, callId: string) =>
  (await db.db.withWorkspace(db.workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId))))[0]!;

const testContext = (db: Stack, tx: unknown) =>
  ({
    tx,
    principal: { workspaceId: db.workspace, userId: 'u_test', permissions: new Set(['profiles:write']) },
    services: { db: db.db, keyProvider: kp, egress: { allowedHosts: ['127.0.0.1'] } },
  }) as never;

const workerDeps = () => ({
  kp,
  // The decide step reads the person's recent events; an empty history is enough for the gate.
  events: { eventsOf: async () => [] } as never,
  egress: { allowedHosts: ['127.0.0.1'] },
});

describe.skipIf(!hasTestDatabase())('the AI consent gate answers for the person a merged-away id names', () => {
  it('refuses an objected person through an id a merge folded into theirs', async () => {
    await publishLegitimateInterestPurposes(interestDb);
    await publishPrompts(interestDb);
    const { survivor, alias } = await mergedPair(interestDb);
    // On legitimate interest the gate allows a person with no record; the objection is on the survivor.
    await setConsent(interestDb, survivor, 'objected');

    await expect(gate(interestDb, survivor)).resolves.toMatchObject({ ok: false });
    await expect(gate(interestDb, alias)).resolves.toMatchObject({ ok: false });

    // ai.classify takes the id as input.profileId and queues the model call for the person's text.
    const queued = await interestDb.db
      .withWorkspace(interestDb.workspace, (tx) =>
        classify.handler(
          { artifactId: classifyPrompt, text: 'Can you tell me more about the plan I bought?', profileId: alias },
          testContext(interestDb, tx),
        ),
      )
      .catch((err: { code?: string }) => err);
    expect(queued).toMatchObject({ code: 'forbidden' });

    // ai.score refuses before it spends budget or builds any state.
    const scored = await interestDb.db
      .withWorkspace(interestDb.workspace, (tx) =>
        score.handler({ profileId: alias, questions: [noul], state: { plan: 'pro' } }, testContext(interestDb, tx)),
      )
      .catch((err: { code?: string }) => err);
    expect(scored).toMatchObject({ code: 'forbidden' });
  }, 60_000);

  it('accepts a person who granted AI consent through an id a merge folded into theirs', async () => {
    await publishPrompts(consentDb);
    const { survivor, alias } = await mergedPair(consentDb);
    // The default purposes put ai_processing on consent.
    await setConsent(consentDb, survivor, 'granted');

    await expect(gate(consentDb, alias)).resolves.toEqual({ ok: true, profileId: survivor });
    await expect(checkScoreProfile(consentDb, alias)).resolves.toBe(survivor);

    // ai.score proceeds (the fake decision provider answers) and its call row names the survivor.
    const scored = await consentDb.db.withWorkspace(consentDb.workspace, (tx) =>
      score.handler({ profileId: alias, questions: [noul], state: { plan: 'pro' } }, testContext(consentDb, tx)),
    );
    expect(scored.answers[0]).toMatchObject({ key: 'propensity', probability: 0.8 });
    expect((await readCall(consentDb, scored.callId)).profileId).toBe(survivor);

    // ai.classify queues the call for the same person the gate answered for.
    const queued = await consentDb.db.withWorkspace(consentDb.workspace, (tx) =>
      classify.handler(
        { artifactId: classifyPrompt, text: 'Can you tell me more about the plan I bought?', profileId: alias },
        testContext(consentDb, tx),
      ),
    );
    expect(queued.status).toBe('pending');
    expect((await readCall(consentDb, queued.callId)).profileId).toBe(survivor);
    // Leave no pending classify call behind for the worker test below.
    await consentDb.db.withWorkspace(consentDb.workspace, (tx) => tx.delete(schema.aiCalls).where(eq(schema.aiCalls.id, queued.callId)));
  }, 60_000);

  it('runs a journey AI step for the person, not the merged-away profile (#1281)', async () => {
    const { survivor, alias } = await mergedPair(consentDb);
    await setConsent(consentDb, survivor, 'granted');
    const call = await queueDecideStep(consentDb, alias);

    const before = llm.requests.length;
    expect(await answerSteps(consentDb.db, workerDeps())).toBe(1);

    const settled = await readCall(consentDb, call.id);
    expect(settled.error ?? '').not.toContain('no_lawful_basis');
    expect(settled.status).toBe('done');
    // The context is the survivor's: the merged-away row keeps no traits after a merge.
    expect(llm.requests).toHaveLength(before + 1);
    expect(llm.requests.at(-1)!.user).toContain('survivor-plan');
  }, 60_000);

  it('falls back a journey AI step for an objected person named through an old id', async () => {
    const { survivor, alias } = await mergedPair(interestDb);
    await setConsent(interestDb, survivor, 'objected');
    const call = await queueDecideStep(interestDb, alias);

    const before = llm.requests.length;
    expect(await answerSteps(interestDb.db, workerDeps())).toBe(1);

    const settled = await readCall(interestDb, call.id);
    expect(settled.status).toBe('fallback');
    expect(settled.error).toContain('no_lawful_basis');
    // The objection was read before any model call.
    expect(llm.requests).toHaveLength(before);
  }, 60_000);
});
