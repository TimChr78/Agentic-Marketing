import { newId } from '@agentic-marketing/core';
import { readErasureLog, replayErasures } from '@agentic-marketing/db';
import { runErasureCleanupOnce, subjectKeyHasher } from '@agentic-marketing/profiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #1194: a restore can keep an erasure `complete` after ClickHouse lost its `erased_subjects`
// rows. A Postgres snapshot that already holds the completed cleanup job replays its log onto a
// ClickHouse point that predates publication; the old `ON CONFLICT DO NOTHING` left the job alone,
// so the erasure still said `complete` while every read returned the person again. A replay must
// make every restored erasure publish its exclusions again, and reads must not claim completion
// before `erased_subjects` holds them.

const PORT = testPort(3595);
const DB = 'test_v0177_restore_republish';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const stamp = Date.now();
const AT = '2026-11-12T10:00:00.000Z';

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let owner: User;
let ws = '';

async function createPerson(label: string) {
  const profileId = newId('prf');
  const anonymousId = `anon-${label}-${stamp}`;
  const userId = `user-${label}-${stamp}`;
  await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, profileId]);
  for (const [type, value] of [
    ['user_id', userId],
    ['anonymous_id', anonymousId],
  ] as const)
    await t.srv.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      ws,
      profileId,
      type,
      value,
    ]);
  return { profileId, anonymousId, userId };
}

const cleanupDeps = () => ({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, hot: t.srv.hot });

const makeDue = (erasureId: string) =>
  t.srv.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET next_attempt_at = now()
      WHERE workspace_id = $1 AND erasure_id = $2 AND state <> 'complete'`,
    [ws, erasureId],
  );

async function completeErasure(erasureId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await runErasureCleanupOnce(cleanupDeps(), {
      finalSweepMs: 0,
      outboxWaitSeconds: 0,
      coverageWaitSeconds: 0,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
    // A round completes whichever jobs it claimed; only this erasure's own job decides the wait.
    const { rows } = await t.srv.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [ws, erasureId],
    );
    if (rows[0]?.state === 'complete' && rows[0].published_at !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await makeDue(erasureId);
  }
  throw new Error(`erasure ${erasureId} did not complete`);
}

async function status(erasureId: string) {
  return t.api(owner, ws).call('profiles.erasureStatus', { erasureId });
}

async function hashesFor(person: { profileId: string; anonymousId: string; userId: string }) {
  const hasher = await subjectKeyHasher({ db: t.srv.db, kp: t.srv.keyProvider })(ws);
  try {
    return {
      profile: await hasher.hash('profile', person.profileId),
      anonymous: await hasher.hash('anonymous_id', person.anonymousId),
      user: await hasher.hash('user_id', person.userId),
      version: hasher.version,
    };
  } finally {
    hasher.dispose();
  }
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function rawInsert(
  person: { profileId: string; anonymousId: string; userId: string },
  hashes: { profile: string; anonymous: string; user: string; version: string },
  eventId: string,
) {
  return `INSERT INTO events
    (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, profile_id,
     properties, traits, context, consent, subject_profile, subject_anonymous, subject_user, subject_key_version, subject_coverage)
    SELECT toUUID(${sqlString(ws)}), ${sqlString(eventId)}, 'src_raw', toDateTime64(${sqlString(AT)}, 3, 'UTC'),
           toDateTime64(${sqlString(AT)}, 3, 'UTC'), 'track', ${sqlString(`Late ${eventId}`)}, ${sqlString(person.anonymousId)},
           ${sqlString(person.userId)}, ${sqlString(person.profileId)}, '{}', '{}', '{}', map(),
           ${sqlString(hashes.profile)}, ${sqlString(hashes.anonymous)}, ${sqlString(hashes.user)}, ${sqlString(hashes.version)}, 'full'
    FROM numbers(1)`;
}

async function ch(query: string) {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  const res = await fetch(url, { method: 'POST', body: query });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text;
}

async function baseCount(table: string, where = '1'): Promise<number> {
  const rs = await t.srv.events.client.query({
    query: `SELECT count() AS n FROM ${table} FINAL WHERE workspace_id = {ws:UUID} AND ${where}`,
    query_params: { ws },
    format: 'JSONEachRow',
    clickhouse_settings: await t.srv.events.settingsFor(ws),
  });
  return Number((await rs.json<{ n: number }>())[0]?.n ?? 0);
}

async function eventually<T>(fn: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT, {}, { erasureCleanup: false, erasurePurge: false });
  owner = await t.signUp(`republish-${stamp}@example.com`);
}, 120_000);

afterAll(() => t?.close());

describe('restore republishes erasure exclusions (#1194)', () => {
  it('reopens a completed job whose ClickHouse exclusions are gone, and reads exclude until they are back', async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const person = await createPerson('restore-job');
    const hashes = await hashesFor(person);
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'restore keeps job' });
    await completeErasure(erased.erasureId);
    // A late direct write that survived the final sweep is hidden by the published ledger.
    await ch(rawInsert(person, hashes, 'restore-late'));
    await eventually(
      () => baseCount('events', "event_id = 'restore-late'"),
      (count) => count === 1,
    );
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);

    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const log = await readErasureLog(databaseUrl);
    // Model a Postgres snapshot that already contained the completed job (so the replay used to
    // insert nothing) next to an older ClickHouse recovery point that predates the publication.
    // The profile and its identifiers come back with the Postgres snapshot, as in the existing test.
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, person.profileId]);
    await t.srv.db.admin.query(
      `INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, 'anonymous_id', $3)
       ON CONFLICT DO NOTHING`,
      [ws, person.profileId, person.anonymousId],
    );
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    await replayErasures(databaseUrl, log);

    const after = await status(erased.erasureId);
    // The erasure must not claim completion while its ClickHouse exclusions are gone. The restored
    // job is back in the publication queue instead of staying complete.
    expect(after).toMatchObject({ status: 'pending', reason: 'publication' });

    // The worker publishes the ledger again; only then does the erasure report complete, and the
    // person stays excluded permanently — including a row written after the republication.
    await completeErasure(erased.erasureId);
    expect((await status(erased.erasureId)).status).toBe('complete');
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
    await ch(rawInsert(person, hashes, 'restore-late-after-republish'));
    await eventually(
      () => baseCount('events', "event_id = 'restore-late-after-republish'"),
      (count) => count === 1,
    );
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
  }, 180_000);
});
