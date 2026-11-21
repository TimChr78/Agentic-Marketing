import { newId } from '@agentic-marketing/core';
import type { MessageEvent } from '@agentic-marketing/events';
import { runErasureCleanupOnce } from '@agentic-marketing/profiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1195, end to end. Two gaps in the read-time exclusion contract of #1037:
//   1. an id-scoped message count read its bounded exclusion set in an earlier query, so a
//      fully-keyed message committed between the two reads was counted for an erased profile;
//   2. a legacy-shaped row (no subject keys, no side entry) written after an erasure completed
//      stayed visible until the next backfill pass, which can be up to an hour later.
// Both tests fail on 0.17.6 and pin the fix: the exclusion happens inside the counting statement,
// and a protected read fails closed for an uncovered row of a workspace with erasures.

const PORT = testPort(3592);
const DB = 'test_v0177_erasure_late_rows';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const stamp = Date.now();
const AT = '2026-11-12T10:00:00.000Z';

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let owner: User;
let ws = '';
let sequence = 0;

const messageEvent = (over: Partial<MessageEvent>): MessageEvent => ({
  workspaceId: ws,
  messageId: `bct_late_${stamp}`,
  eventId: `me-late-${stamp}-${sequence++}`,
  type: 'sent',
  at: AT,
  profileId: '',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: 'eml_late',
  templateVersion: 1,
  journeyId: `bct_late_${stamp}`,
  reason: '',
  url: '',
  ...over,
});

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

async function completeErasure(erasureId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await runErasureCleanupOnce(cleanupDeps(), {
      finalSweepMs: 0,
      outboxWaitSeconds: 0,
      coverageWaitSeconds: 0,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
    if (result.completed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.srv.db.admin.query(
      `UPDATE erasure_cleanup_jobs SET next_attempt_at = now()
        WHERE workspace_id = $1 AND erasure_id = $2 AND state <> 'complete'`,
      [ws, erasureId],
    );
  }
  throw new Error(`erasure ${erasureId} did not complete`);
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The row an older, pre-0.17.0 writer would insert: the identifiers, no subject keys and no
 * coverage. The protected view cannot match it by key, and there is no side entry for it.
 */
function rawLegacyInsert(person: { profileId: string; anonymousId: string; userId: string }, eventId: string) {
  return `INSERT INTO events
    (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, profile_id,
     properties, traits, context, consent)
    SELECT toUUID(${sqlString(ws)}), ${sqlString(eventId)}, 'src_legacy', toDateTime64(${sqlString(AT)}, 3, 'UTC'),
           toDateTime64(${sqlString(AT)}, 3, 'UTC'), 'track', ${sqlString(`Legacy ${eventId}`)}, ${sqlString(person.anonymousId)},
           ${sqlString(person.userId)}, ${sqlString(person.profileId)}, '{}', '{}', '{}', map()
    FROM numbers(1)`;
}

/** A synchronous ClickHouse write, as the drain-era writer would have made it. */
async function ch(query: string) {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  const res = await fetch(url, { method: 'POST', body: query });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text;
}

async function baseCount(table: string, where: string): Promise<number> {
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
  owner = await t.signUp(`late-${stamp}@example.com`);
}, 120_000);

/** A fresh workspace per test: the coverage gate is workspace-wide, so an uncovered row would
 * block every later erasure in this file. */
async function freshWorkspace() {
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}

afterAll(() => t?.close());

describe('erasure exclusion for late rows (#1195)', () => {
  it('hides a legacy-shaped row written after completion, before the backfill covers it', async () => {
    await freshWorkspace();
    const person = await createPerson('legacy');
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'legacy late row' });
    await completeErasure(erased.erasureId);
    expect((await t.api(owner, ws).call('profiles.erasureStatus', { erasureId: erased.erasureId })).status).toBe('complete');

    // This writer (an older replica that the upgrade doc says to drain) inserts after the coverage
    // gate recorded its point-in-time zero, with no subject keys and no side entry.
    await ch(rawLegacyInsert(person, 'legacy-after-complete'));
    await eventually(
      () => baseCount('events', "event_id = 'legacy-after-complete'"),
      (count) => count === 1,
    );
    const beforeBackfill = await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] });
    // The next backfill pass hashes the raw ids the row still stores; the row was already hidden.
    await t.srv.events.backfillSubjectKeys({ workspaceIds: [ws], batchSize: 100 });
    const afterBackfill = await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] });
    expect({ beforeBackfill: beforeBackfill.length, afterBackfill: afterBackfill.length }).toEqual({
      beforeBackfill: 0,
      afterBackfill: 0,
    });
  }, 120_000);

  it('excludes a message committed between the scope read and the count', async () => {
    await freshWorkspace();
    const person = await createPerson('scope-race');
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'message scope race' });
    await completeErasure(erased.erasureId);

    const lateMessageId = `bct_scope_race_${stamp}`;
    let injected = false;
    const store = t.srv.events;
    const realQuery = store.client.query.bind(store.client);
    // The bounded key probe runs before the count. Commit the late row after it returned: a count
    // that trusts the probe's key list misses the row, a count that derives its own bound excludes
    // it.
    store.client.query = (async (args: Parameters<typeof store.client.query>[0]) => {
      const result = await realQuery(args);
      if (!injected && String(args.query).includes('arrayJoin([m.subject_profile, s.side_profile])')) {
        injected = true;
        await store.insertMessageEvents([
          messageEvent({ profileId: person.profileId, type: 'delivered', messageId: lateMessageId, journeyId: lateMessageId }),
        ]);
      }
      return result;
    }) as typeof store.client.query;

    try {
      const counts = await store.countMessageEvents(ws, { type: 'delivered', sinceSeconds: 40 * 86_400, sentBy: lateMessageId });
      expect(injected).toBe(true);
      expect(counts).toEqual([]);
    } finally {
      store.client.query = realQuery;
    }
  }, 120_000);
});
