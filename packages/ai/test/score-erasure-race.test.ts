import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { disposeErasure, eraseProfileStage, prepareErasure } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { finishIn } from '../src/steps';
import { blockedBy, type ClientLike, holdPause, type Queryable, releasePause, waitFor } from './raceSupport';

// #1274: score finalisation fenced the `ai_calls` attempt first and then locked the profile, while
// profile erasure locks the profile first and its cascade deletes the `ai_calls` row. When the two
// ran at once for one person each waited for what the other held, and PostgreSQL aborted one with
// 40P01. The finalisation must take the profile lock before the attempt fence, like erasure does.

const MASTER_KEY = Buffer.alloc(32, 45).toString('base64');
const PAUSE_KEY = 'test:pause-ai-erasure-message-delete';

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_erasure_race');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function seedProfile(id: string) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.insert(schema.identifiers).values({ workspaceId: ws, profileId: id, type: 'anonymous_id', value: `anon-${id}` });
  });
}

/** A message the erasure deletes before it reaches the profile rows: the pause point. */
async function seedMessage(profileId: string) {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status)
     VALUES ($1, $2, $3, 'email', 'marketing_email', $4, 'sent')`,
    [ws, id, `idem_${id}`, profileId],
  );
  return id;
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

/**
 * Stops the erasure at the first row delete it makes: it has already taken the profile row locks and
 * has not yet reached the profile delete whose cascade touches `ai_calls`.
 */
async function installErasurePause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_ai_erasure_message_delete() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${PAUSE_KEY}', 0));
      RETURN OLD;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_ai_erasure_message_delete ON messages;
    CREATE TRIGGER test_pause_ai_erasure_message_delete BEFORE DELETE ON messages
      FOR EACH ROW EXECUTE FUNCTION test_pause_ai_erasure_message_delete();`);
}

async function dropErasurePause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_ai_erasure_message_delete ON messages');
}

/** The backend waiting on the test pause: the erasure, holding the profile row lock. */
async function pausedErasure(conn: Queryable): Promise<number> {
  return waitFor('the erasure to wait on its pause', async () => {
    const { rows } = await conn.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.wait_event_type = 'Lock'
          AND EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.pid = a.pid AND l.locktype = 'advisory' AND NOT l.granted
                         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                         AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                         AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid)`,
      [PAUSE_KEY],
    );
    return rows[0]?.pid;
  });
}

describe.skipIf(!hasTestDatabase())('a score finalisation and an erasure do not deadlock (#1274)', () => {
  it('lets the erasure finish when the person is erased while their score step finalises', async () => {
    const p = newId('prf');
    await seedProfile(p);
    await seedMessage(p);
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

    const prepared = await prepareErasure(d.db, ws, kp);
    const probe = await d.db.admin.connect();
    let erasing: Promise<unknown> | undefined;
    let finishing: Promise<unknown> | undefined;
    let erasureError: unknown;
    let finishError: unknown;
    try {
      await installErasurePause(probe);
      await holdPause(probe as ClientLike, PAUSE_KEY);
      // The erasure takes the profile row lock and stops at its first delete.
      erasing = d.db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: ws,
          profileId: p,
          requestedBy: 'user_test',
          reason: 'erase racing a score finalisation',
          prepared,
        }),
      );
      const erasurePid = await pausedErasure(probe);

      finishing = d.db.withWorkspace(ws, (tx) =>
        finishIn(tx, call!, null, {
          status: 'done',
          option: 'yes',
          probability: 0.9,
          storeScore: {
            profileId: p,
            key: 'purchase',
            answer: { key: 'purchase', type: 'choice', probability: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
            model: 'test-model',
            modelVersion: 'v1',
            callId,
            ttlHours: 168,
          },
        }),
      );
      // Wait until the finalisation is waiting on the erasure, so the release below cannot happen
      // before the two transactions overlap.
      await waitFor('the finalisation to wait for the erasure', async () => (await blockedBy(probe, erasurePid)).length > 0);

      await releasePause(probe as ClientLike, PAUSE_KEY);
    } finally {
      await releasePause(probe as ClientLike, PAUSE_KEY).catch(() => {});
      await dropErasurePause(probe).catch(() => {});
      // Settle both transactions before the probe connection goes back to the pool.
      const [e, f] = await Promise.allSettled([erasing, finishing]);
      erasureError = e?.status === 'rejected' ? e.reason : undefined;
      finishError = f?.status === 'rejected' ? f.reason : undefined;
      probe.release();
      disposeErasure(prepared);
    }

    // On main one of the two is aborted with 40P01.
    expect(erasureError).toBeUndefined();
    expect(finishError).toBeUndefined();

    const erasure = (await erasing!) as { profileIds: string[] };
    expect(erasure.profileIds).toEqual([p]);
    // The erasure won, and the finalisation did not bring the person, their score or their call back.
    const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, p]);
    expect(left.rowCount).toBe(0);
    const scores = await d.db.admin.query('SELECT 1 FROM profile_scores WHERE workspace_id = $1 AND profile_id = $2', [ws, p]);
    expect(scores.rowCount).toBe(0);
    const calls = await d.db.admin.query('SELECT 1 FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId]);
    expect(calls.rowCount).toBe(0);
    const participant = await d.db.admin.query('SELECT 1 FROM journey_participants WHERE workspace_id = $1 AND id = $2', [
      ws,
      participantId,
    ]);
    expect(participant.rowCount).toBe(0);
  }, 120_000);
});
