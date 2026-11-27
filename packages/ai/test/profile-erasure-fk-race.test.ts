import { artifactTypes } from '@agentic-marketing/artifacts';
import { type AppError, newId } from '@agentic-marketing/core';
import { createDb, schema } from '@agentic-marketing/db';
import { disposeErasure, eraseProfileStage, prepareErasure } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  // Only the provider key is opened on this path; nothing else about the key provider matters here.
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { classify } from '../src/classify';
import { score } from '../src/score';
import { fakeSystemOne } from '../src/testing';
import { type ClientLike, holdPause, type Queryable, releasePause, waitFor } from './raceSupport';

// #1274 review: `ai.classify` checks the person's AI consent and then inserts an `ai_calls` row that
// names them; the SDK `ai.score` path does the same in the transaction that settles the call. An
// erasure committing in between deleted the profile, and the insert then failed its foreign key
// with a raw 23503. Both now lock the canonical profile before the insert, the order erasure takes
// (profile, then the `ai_calls` rows its cascade deletes), so the erasure waits and the caller gets
// a clean outcome instead of a database error.

const MASTER_KEY = Buffer.alloc(32, 67).toString('base64');
const providerId = `aip_${'9'.repeat(32)}`;
const classifyPrompt = `prm_${'e'.repeat(32)}`;

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let systemOne: Awaited<ReturnType<typeof fakeSystemOne>>;
/**
 * The command's own transaction gets its own one-connection pool: the disposable database's app pool
 * has two, and the paused settling transaction plus the erasure need both of them.
 */
let commandDb: ReturnType<typeof createDb>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_profile_erasure_fk_race');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
  commandDb = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 1 });
  systemOne = await fakeSystemOne(() => ({ answers: { propensity: { type: 'noul', noul: 0.8 } } }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake decisions', 'decision', $3, '{"default":"jev-test-1.0.0"}'::jsonb, ARRAY['decisions'], '', '\\x00'::bytea, 'k_test')`,
    [ws, providerId, systemOne.baseUrl],
  );
}, 120_000);

afterAll(async () => {
  await systemOne?.close();
  await commandDb?.close();
  await d?.close();
});

async function seedConsentedProfile(): Promise<string> {
  const id = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.insert(schema.identifiers).values({ workspaceId: ws, profileId: id, type: 'anonymous_id', value: `anon-${id}` });
    // The default purposes put ai_processing on consent, so a granted record is enough.
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: id,
      purpose: 'ai_processing',
      status: 'granted',
      basis: 'consent',
      source: 'api',
      updatedAt: new Date(),
    });
  });
  return id;
}

async function publishClassifyPrompt() {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id: classifyPrompt,
      type: 'prompt',
      name: 'Reply intent',
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: classifyPrompt,
      number: 1,
      state: 'published',
      content: artifactTypes.prompt.content.parse({
        kind: 'classify',
        instructions: 'Label the reply.',
        options: [
          { key: 'question', description: 'Asks something' },
          { key: 'other', description: 'Anything else' },
        ],
        trait: 'reply_intent',
      }),
      contentHash: 'h',
      authorType: 'user',
      authorId: 'u_test',
    });
  });
}

/**
 * Stops a call-row insert for one kind before it happens. The transaction has already locked the
 * person (the fix) and not yet taken the foreign key check, so an erasure has the window the bug
 * needed.
 */
async function installInsertPause(conn: Queryable, kind: string, key: string): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_ai_call_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${key}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_ai_call_insert ON ai_calls;
    CREATE TRIGGER test_pause_ai_call_insert BEFORE INSERT ON ai_calls
      FOR EACH ROW WHEN (NEW.kind = '${kind}') EXECUTE FUNCTION test_pause_ai_call_insert();`);
}

async function dropInsertPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_ai_call_insert ON ai_calls');
}

/** The backend waiting on the test pause: the command that is about to insert the call row. */
async function pausedInsert(conn: Queryable, key: string): Promise<number> {
  return waitFor('the call insert to wait on its pause', async () => {
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

/**
 * Runs one erasure while the paused command holds its person lock. It finishes at once on the
 * unfixed code (the command took no profile lock); with the fix it waits for the lock, and the
 * release then lets both commit.
 */
async function raceErasure(conn: ClientLike, profileId: string, pausedPid: number, key: string): Promise<{ error: unknown }> {
  const prepared = await prepareErasure(d.db, ws, kp);
  const state = { finished: false };
  const erasing = d.db
    .withWorkspace(ws, (tx) =>
      eraseProfileStage(tx, {
        workspaceId: ws,
        profileId,
        requestedBy: 'user_test',
        reason: 'erase racing an AI call insert',
        prepared,
      }),
    )
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      state.finished = true;
      disposeErasure(prepared);
    });
  // Wait until the erasure is either blocked by the paused command (the fix) or done (no lock).
  await waitFor('the erasure to reach the paused command', async () => {
    if (state.finished) return true;
    const { rows } = await conn.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(a.pid))`,
      [pausedPid],
    );
    return rows.length > 0;
  });
  await releasePause(conn, key);
  return erasing;
}

const testContext = (tx: unknown) =>
  ({
    tx,
    principal: { workspaceId: ws, userId: 'u_test', permissions: new Set(['profiles:write']) },
    services: { db: d.db, keyProvider: kp, egress: { allowedHosts: ['127.0.0.1'] } },
  }) as never;

describe.skipIf(!hasTestDatabase())('an AI call insert and an erasure do not race the foreign key (#1274)', () => {
  it('queues an ai.classify call cleanly when the person is erased at the same time', async () => {
    const key = 'test:pause-ai-call-classify';
    await publishClassifyPrompt();
    const p = await seedConsentedProfile();
    const probe = await d.db.admin.connect();
    let queued: { callId: string; status: string } | undefined;
    let queuedError: AppError | undefined;
    try {
      await installInsertPause(probe, 'classify', key);
      await holdPause(probe as ClientLike, key);
      const pausing = d.db.withWorkspace(ws, (tx) =>
        classify.handler({ artifactId: classifyPrompt, text: 'Can you tell me more?', profileId: p }, testContext(tx)),
      );
      const pausePid = await pausedInsert(probe, key);
      const { error } = await raceErasure(probe as ClientLike, p, pausePid, key);
      expect(error).toBeUndefined();
      // On the unfixed code the insert raised a raw 23503 here.
      await expect(pausing).resolves.toBeDefined();
      queued = await pausing.catch((err: AppError) => {
        queuedError = err;
        return undefined;
      });
    } finally {
      await releasePause(probe as ClientLike, key).catch(() => {});
      await dropInsertPause(probe).catch(() => {});
      probe.release();
    }

    expect(queuedError).toBeUndefined();
    expect(queued?.status).toBe('pending');
    // The erasure won after the queued call committed; its cascade removed the call row too.
    const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, p]);
    expect(left.rowCount).toBe(0);
    const calls = await d.db.admin.query('SELECT 1 FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, queued!.callId]);
    expect(calls.rowCount).toBe(0);
  }, 120_000);

  it('settles an ai.score call without the erased person instead of failing its insert', async () => {
    const key = 'test:pause-ai-call-score';
    const p = await seedConsentedProfile();
    const probe = await d.db.admin.connect();
    let scored: { callId: string; stored: unknown } | undefined;
    let scoredError: unknown;
    try {
      await installInsertPause(probe, 'score', key);
      await holdPause(probe as ClientLike, key);
      const scoring = commandDb.withWorkspace(ws, (tx) =>
        score.handler(
          {
            profileId: p,
            questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
            state: { plan: 'pro' },
          },
          testContext(tx),
        ),
      );
      const pausePid = await pausedInsert(probe, key);
      const { error } = await raceErasure(probe as ClientLike, p, pausePid, key);
      expect(error).toBeUndefined();
      // On the unfixed code the settling insert raised a raw 23503 here.
      scored = await scoring.catch((err: unknown) => {
        scoredError = err;
        return undefined;
      });
    } finally {
      await releasePause(probe as ClientLike, key).catch(() => {});
      await dropInsertPause(probe).catch(() => {});
      probe.release();
    }

    expect(scoredError).toBeUndefined();
    expect(scored?.callId).toBeDefined();
    // The score may be written before or after the erasure takes the lock; either way the erasure
    // leaves nothing behind, and the command never failed its call-row insert.
    const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, p]);
    expect(left.rowCount).toBe(0);
    const calls = await d.db.admin.query('SELECT 1 FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, scored!.callId]);
    expect(calls.rowCount).toBe(0);
  }, 120_000);
});
