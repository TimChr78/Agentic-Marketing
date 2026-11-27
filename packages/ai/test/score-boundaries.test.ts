import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { storeProfileScore } from '../src/decision';
import { profileScores } from '../src/score';

// #1241 review: a decision queued before a merge checked the old profile's consent and built its
// context from the old id, so it fell back with no_lawful_basis although the survivor consented.
// A merge that commits between the lookup and the lock must also not lose a standalone score.

const MASTER_KEY = Buffer.alloc(32, 62).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 6, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_boundaries');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_score_boundary',
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

async function seedProfile(id: string, idents: { anonymous?: string; user?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

const merge = (anonymous: string, user: string) => {
  const batch = [event({ anonymousId: anonymous, userId: user })];
  return withPreparedKeys(
    async () => {
      const ids = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds: ids });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );
};

const readScores = (profileId: string) =>
  d.db.withWorkspace(ws, (tx) => profileScores.handler({ profileId }, { tx, principal: { workspaceId: ws } } as never));

const answer = { key: 'buy', type: 'noul' as const, probability: 0.8, probabilities: { true: 0.8, false: 0.2 } };

async function awaitProfileLockWait() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await d.db.admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%from profiles%'",
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The score did not wait for the profile lock');
}

const question = { key: 'buy', type: 'noul', instructions: 'Will this person buy?' };

async function queuedCall(profileId: string) {
  return d.db.withWorkspace(ws, async (tx) => {
    const [p] = await tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId: newId('jrn'),
        version: 1,
        profileId,
        entryKey: newId('test'),
        node: 'decision',
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.now() + 300_000),
      })
      .returning();
    const [call] = await tx
      .insert(schema.aiCalls)
      .values({
        workspaceId: ws,
        id: newId('aic'),
        kind: 'score',
        status: 'pending',
        participantId: p!.id,
        node: 'decision',
        seq: 1,
        profileId,
        input: { questions: [question] },
      })
      .returning();
    return call!;
  });
}

describe.skipIf(!hasTestDatabase())('score boundary review', () => {
  it('prepares a pre-merge queued decision using the survivor’s consent', async () => {
    const { answerSteps } = await import('../src/steps');
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 6, 1)));
    await seedProfile(alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 6, 2)));
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.consentRecords).values({
        workspaceId: ws,
        profileId: survivor,
        purpose: 'ai_processing',
        basis: 'consent',
        status: 'granted',
        source: 'import',
      }),
    );
    const call = await queuedCall(alias);
    await merge(`anon-${alias}`, `user-${survivor}`);
    const { aiAllowed } = await import('../src/context');
    expect((await d.db.withWorkspace(ws, (tx) => aiAllowed(tx, ws, survivor))).ok).toBe(true);
    await answerSteps(d.db, { kp, events: {} as never });
    const [result] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, call.id)));
    expect(result?.error).not.toContain('no_lawful_basis');
  });

  it('stores the score when a merge commits between lookup and lock', async () => {
    const { lockProfileRows } = await import('@agentic-marketing/profiles');
    const oldRoot = newId('prf');
    const survivor = newId('prf');
    await seedProfile(oldRoot, {}, new Date());
    await seedProfile(survivor, {}, new Date());
    // The write re-reads consent under its lock (#1300).
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.consentState).values({
        workspaceId: ws,
        profileId: survivor,
        purpose: 'ai_processing',
        channel: '',
        status: 'granted',
        basis: 'consent',
        source: 'form',
        updatedAt: new Date(),
      }),
    );
    let pending: ReturnType<typeof storeProfileScore> | undefined;
    await d.db.withWorkspace(ws, async (tx) => {
      await lockProfileRows(tx, ws, [oldRoot, survivor]);
      pending = storeProfileScore(d.db, ws, {
        profileId: oldRoot,
        key: 'raced',
        answer,
        model: 'test',
        modelVersion: 'v1',
        callId: null,
        ttlHours: 1,
      });
      await awaitProfileLockWait();
      await tx.update(schema.profiles).set({ mergedInto: survivor }).where(eq(schema.profiles.id, oldRoot));
    });
    expect(await pending).toMatchObject({ profileId: survivor });
    expect((await readScores(survivor)).scores.map((s) => s.key)).toContain('raced');
  });
});
