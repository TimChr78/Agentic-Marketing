import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { finishIn } from '../src/steps';
import {
  blockedBy,
  dropIdentifierPause,
  holdPause,
  IDENTIFIER_PAUSE_KEY,
  installIdentifierPause,
  releasePause,
  waitFor,
  waitForAdvisoryHolderBlocked,
} from './raceSupport';

// #1011 review: the AI score finalisation used to lock the journey participant row and then the
// profile row, the opposite of the documented order (identity lock, then profile rows ascending,
// then participant rows). An SDK batch that merges the person locks the profile first and then
// waits for the participant row, so the two formed the same cycle the journey sweep had.

const MASTER_KEY = Buffer.alloc(32, 44).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_merge_race');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_ai_race',
    messageId: newId('evt'),
    type: 'track',
    name: 'Page Viewed',
    anonymousId: '',
    userId: '',
    timestamp,
    receivedAt: timestamp,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
    ...over,
  };
};

const runBatch = (events: BusEvent[]) =>
  withPreparedKeys(
    async () => {
      const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, events, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, events, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

async function seedProfile(id: string, idents: { anonymous?: string; user?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

/** A participant waiting at the score step of a decision node, as the journey sweep leaves it. */
async function waitingScoreParticipant(profileId: string): Promise<number> {
  const journeyId = newId('jrn');
  const [row] = await d.db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId,
        version: 1,
        profileId,
        entryKey: `test:${profileId}`,
        node: 'decide',
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.UTC(2026, 0, 3)),
      })
      .returning({ id: schema.journeyParticipants.id }),
  );
  return row!.id;
}

describe.skipIf(!hasTestDatabase())('a score finalisation and a merge do not deadlock (#1011 review)', () => {
  it('finishes the score and the merge when both touch one person', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 0, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 0, 2)));
    const participantId = await waitingScoreParticipant(p);
    const callId = newId('aic');
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id: callId,
        kind: 'score',
        status: 'running',
        attempts: 1,
        participantId,
        node: 'decide',
        seq: 1,
        profileId: p,
        input: {},
      }),
    );
    const [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));

    const probe = await d.db.admin.connect();
    let merge: Promise<unknown> | undefined;
    let scored: Promise<unknown> | undefined;
    let mergeError: unknown;
    let scoreError: unknown;
    try {
      await installIdentifierPause(probe);
      await holdPause(probe, IDENTIFIER_PAUSE_KEY);
      // The merge holds the profile rows and stops before it moves the participant row: exactly the
      // point where a participant-first score path waits for the profile it cannot get.
      merge = runBatch([event({ anonymousId: `anon-${p}`, userId: `user-${q}` })]);
      const batchPid = await waitForAdvisoryHolderBlocked(probe, ws);

      scored = d.db.withWorkspace(ws, (tx) => finishIn(tx, call!, null, { status: 'done', option: 'yes', probability: 0.9 }));
      // Wait until the score path is blocked by the merge, so the release below cannot happen before
      // the two transactions overlap.
      await waitFor('the score path to wait for the merge', async () => (await blockedBy(probe, batchPid)).length > 0);

      await releasePause(probe, IDENTIFIER_PAUSE_KEY);
    } finally {
      await releasePause(probe, IDENTIFIER_PAUSE_KEY).catch(() => {});
      await dropIdentifierPause(probe).catch(() => {});
      // Settle both transactions before the probe connection goes back to the pool.
      const [m, s] = await Promise.allSettled([merge, scored]);
      mergeError = m?.status === 'rejected' ? m.reason : undefined;
      scoreError = s?.status === 'rejected' ? s.reason : undefined;
      probe.release();
    }

    // A deadlock would reject one of them with 40P01.
    expect(mergeError).toBeUndefined();
    expect(scoreError).toBeUndefined();
    const { rows: calls } = await d.db.admin.query<{ status: string }>('SELECT status FROM ai_calls WHERE workspace_id = $1 AND id = $2', [
      ws,
      callId,
    ]);
    expect(calls[0]?.status).toBe('done');
    const { rows: participants } = await d.db.admin.query<{ profile_id: string; context: { ai?: Record<string, unknown> } }>(
      'SELECT profile_id, context FROM journey_participants WHERE workspace_id = $1 AND id = $2',
      [ws, participantId],
    );
    const participant = participants[0];
    // The merge moved the person, and the score still reached the participant it was computed for.
    expect(participant?.profile_id).toBe(q);
    expect(participant?.context.ai?.decide).toMatchObject({ option: 'yes' });
  }, 120_000);
});
