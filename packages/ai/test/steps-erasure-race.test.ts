import { newId } from '@agentic-marketing/core';
import { type AiCallKind, schema } from '@agentic-marketing/db';
import { disposeErasure, eraseProfileStage, prepareErasure } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { finishIn } from '../src/steps';
import { blockedBy, type ClientLike, holdPause, type Queryable, releasePause, waitFor } from './raceSupport';

// #1274 review: the same inversion as the score finalisation (#1274) still existed for a journey
// step that is not a score. `finishIn` fenced the `ai_calls` row (FOR UPDATE) and then updated the
// participant row, while erasure locks the profile first, deletes the participant rows and only
// then reaches the profile delete whose cascade removes `ai_calls`. A decide or generate step
// finalising during an erasure held the `ai_calls` row while waiting for a participant row the
// erasure held, and the erasure's cascade waited for that `ai_calls` row: PostgreSQL aborted one
// of them with 40P01. Every kind that has a profile now takes the profile lock before anything
// else, the order erasure uses.

const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_steps_erasure_race');
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

async function waitingParticipant(profileId: string, node: string): Promise<number> {
  const journeyId = newId('jrn');
  const [row] = await d.db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId,
        version: 1,
        profileId,
        entryKey: `test:${profileId}:${node}`,
        node,
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.UTC(2026, 0, 3)),
      })
      .returning({ id: schema.journeyParticipants.id }),
  );
  return row!.id;
}

/**
 * Stops the erasure at its last row delete: it has already deleted (and so holds) the participant
 * rows and has not yet reached the profile delete whose cascade touches `ai_calls`.
 */
async function installProfileDeletePause(conn: Queryable, key: string): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_ai_step_profile_delete() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${key}', 0));
      RETURN OLD;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_ai_step_profile_delete ON profiles;
    CREATE TRIGGER test_pause_ai_step_profile_delete BEFORE DELETE ON profiles
      FOR EACH ROW EXECUTE FUNCTION test_pause_ai_step_profile_delete();`);
}

async function dropProfileDeletePause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_ai_step_profile_delete ON profiles');
}

/** The backend waiting on the test pause: the erasure, holding the participant row locks. */
async function pausedErasure(conn: Queryable, key: string): Promise<number> {
  return waitFor('the erasure to wait on its pause', async () => {
    const { rows } = await conn.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.wait_event_type = 'Lock'
          AND EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.pid = a.pid AND l.locktype = 'advisory' AND NOT l.granted
                         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                         AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                         AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid)`,
      [key],
    );
    return rows[0]?.pid;
  });
}

const kinds = [
  { kind: 'decide' as const, out: { status: 'done' as const, option: 'yes', rationale: 'test' } },
  { kind: 'generate' as const, out: { status: 'done' as const, slots: { body: 'hello' } } },
];

describe.skipIf(!hasTestDatabase())('a journey step finalisation and an erasure do not deadlock (#1274)', () => {
  for (const { kind, out } of kinds) {
    it(`lets the erasure finish when the person is erased while their ${kind} step finalises`, async () => {
      const pauseKey = `test:pause-ai-step-erasure-${kind}`;
      const p = newId('prf');
      await seedProfile(p);
      const participantId = await waitingParticipant(p, kind);
      const callId = newId('aic');
      await d.db.withWorkspace(ws, (tx) =>
        tx.insert(schema.aiCalls).values({
          workspaceId: ws,
          id: callId,
          kind: kind as AiCallKind,
          status: 'running',
          attempts: 1,
          participantId,
          node: kind,
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
        await installProfileDeletePause(probe, pauseKey);
        await holdPause(probe as ClientLike, pauseKey);
        erasing = d.db.withWorkspace(ws, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: ws,
            profileId: p,
            requestedBy: 'user_test',
            reason: `erase racing a ${kind} finalisation`,
            prepared,
          }),
        );
        const erasurePid = await pausedErasure(probe, pauseKey);

        finishing = d.db.withWorkspace(ws, (tx) => finishIn(tx, call!, null, out));
        // Wait until the finalisation is waiting on the erasure, so the release below cannot happen
        // before the two transactions overlap.
        await waitFor('the finalisation to wait for the erasure', async () => (await blockedBy(probe, erasurePid)).length > 0);

        await releasePause(probe as ClientLike, pauseKey);
      } finally {
        await releasePause(probe as ClientLike, pauseKey).catch(() => {});
        await dropProfileDeletePause(probe).catch(() => {});
        // Settle both transactions before the probe connection goes back to the pool.
        const [e, f] = await Promise.allSettled([erasing, finishing]);
        erasureError = e?.status === 'rejected' ? e.reason : undefined;
        finishError = f?.status === 'rejected' ? f.reason : undefined;
        probe.release();
        disposeErasure(prepared);
      }

      // On the unfixed code one of the two is aborted with 40P01.
      expect(erasureError).toBeUndefined();
      expect(finishError).toBeUndefined();

      const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, p]);
      expect(left.rowCount).toBe(0);
      const participant = await d.db.admin.query('SELECT 1 FROM journey_participants WHERE workspace_id = $1 AND id = $2', [
        ws,
        participantId,
      ]);
      expect(participant.rowCount).toBe(0);
      const calls = await d.db.admin.query('SELECT 1 FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId]);
      expect(calls.rowCount).toBe(0);
    }, 120_000);
  }
});
