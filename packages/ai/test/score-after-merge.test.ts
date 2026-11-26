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
import { finishIn } from '../src/steps';

// #1241 (incomplete #1144 fix): a score written for a profile id that was already merged away was
// stored on the tombstone row, where no reader looks. Both writers — ai.score's `store` and a
// journey decision step — must resolve the canonical person before writing.

const MASTER_KEY = Buffer.alloc(32, 62).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 6, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_after_merge');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_score_after_merge',
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

const scoreRows = async (key: string) =>
  (
    await d.db.admin.query<{ profile_id: string; key: string }>(
      'SELECT profile_id, key FROM profile_scores WHERE workspace_id = $1 AND key = $2 ORDER BY profile_id',
      [ws, key],
    )
  ).rows;

const answer = { key: 'buy', type: 'noul' as const, probability: 0.8, probabilities: { true: 0.8, false: 0.2 } };

describe.skipIf(!hasTestDatabase())('a score written after a merge goes to the survivor (#1241)', () => {
  it('ai.score store: the score is stored for the canonical profile and reads back through either id', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 6, 1)));
    await seedProfile(alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 6, 2)));
    await merge(`anon-${alias}`, `user-${survivor}`);

    const stored = await storeProfileScore(d.db, ws, {
      profileId: alias,
      key: 'propensity',
      answer,
      model: 'test-model',
      modelVersion: 'v1',
      callId: null,
      ttlHours: 168,
    });
    expect(stored).not.toBeNull();
    expect(await scoreRows('propensity')).toEqual([{ profile_id: survivor, key: 'propensity' }]);
    expect((await readScores(alias)).scores).toHaveLength(1);
    expect((await readScores(survivor)).scores).toHaveLength(1);
  }, 60_000);

  it('journey decision step: a call queued before the merge stores its score on the survivor', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 6, 3)));
    await seedProfile(alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 6, 4)));
    const journeyId = newId('jrn');
    const [participant] = await d.db.withWorkspace(ws, (tx) =>
      tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId,
          version: 1,
          profileId: alias,
          entryKey: `test:${alias}`,
          node: 'decide',
          seq: 1,
          status: 'waiting',
          dueAt: new Date(Date.UTC(2026, 6, 5)),
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
        profileId: alias,
        input: {},
      }),
    );
    // The person merges (e.g. signs in) while the decision call is queued or in flight.
    await merge(`anon-${alias}`, `user-${survivor}`);
    const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));

    await d.db.withWorkspace(ws, (tx) =>
      finishIn(tx, call!, null, {
        status: 'done',
        probability: answer.probability,
        output: { answers: [answer] },
        storeScore: {
          profileId: call!.profileId!,
          key: 'journey',
          answer,
          model: 'test-model',
          modelVersion: 'v1',
          callId: call!.id,
          ttlHours: 168,
        },
      }),
    );

    expect(await scoreRows('journey')).toEqual([{ profile_id: survivor, key: 'journey' }]);
    expect((await readScores(alias)).scores).toHaveLength(1);
    expect((await readScores(survivor)).scores).toHaveLength(1);
  }, 60_000);
});
