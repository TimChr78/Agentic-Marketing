import { newId } from '@agentic-marketing/core';
import { readErasureLog, replayErasures } from '@agentic-marketing/db';
import { type BusEvent, type EventBus, type EventStore, type JourneyEvent, type MessageEvent, runSink } from '@agentic-marketing/events';
import { erasedEventFilter, runErasureCleanupOnce, runErasurePurgeOnce, subjectKeyHasher } from '@agentic-marketing/profiles';
import { readDataset } from '@agentic-marketing/warehouse';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #1037 part 3, end to end. Once an erasure reports complete, every read started afterwards
// excludes the subject — including rows a ClickHouse write commits later, a buffered async insert,
// direct writers that passed a stale eligibility check, a sink redelivery, and a restore that
// replays the ledger. Each race is driven through production writers and the real worker; physical
// deletion is a separate, eventual milestone.

const PORT = testPort(3572);
const DB = 'test_v0170_erasure_contract';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const stamp = Date.now();
const AT = '2026-11-12T10:00:00.000Z';
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let owner: User;
let ws = '';
let sequence = 0;

const event = (over: Partial<BusEvent>): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_contract',
  messageId: `contract-${stamp}-${sequence++}`,
  type: 'track',
  name: 'Purchase',
  anonymousId: '',
  userId: '',
  profileId: '',
  timestamp: AT,
  receivedAt: AT,
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const messageEvent = (over: Partial<MessageEvent>): MessageEvent => ({
  workspaceId: ws,
  messageId: `bct_contract_${stamp}`,
  eventId: `me-contract-${stamp}-${sequence++}`,
  type: 'sent',
  at: AT,
  profileId: '',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: 'eml_contract',
  templateVersion: 1,
  journeyId: `bct_contract_${stamp}`,
  reason: '',
  url: '',
  ...over,
});

const journeyEvent = (over: Partial<JourneyEvent>): JourneyEvent => ({
  workspaceId: ws,
  journeyId: `jrn_contract_${stamp}`,
  version: 1,
  participantId: 1,
  profileId: '',
  node: 'start',
  type: 'entered',
  seq: 1,
  at: AT,
  detail: '',
  ...over,
});

/** A person created the way the resolver creates one, so profiles.erase has someone to erase. */
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

/** Drives the production worker until this erasure is logically complete. */
async function completeErasure(erasureId: string, opts: { finalSweepMs?: number } = {}) {
  for (let round = 0; round < 8; round++) {
    const result = await runErasureCleanupOnce(cleanupDeps(), {
      finalSweepMs: opts.finalSweepMs ?? 0,
      outboxWaitSeconds: 0,
      coverageWaitSeconds: 0,
    });
    if (result.completed) return;
    await makeDue(erasureId);
  }
  throw new Error(`erasure ${erasureId} did not complete`);
}

async function status(erasureId: string) {
  return t.api(owner, ws).call('profiles.erasureStatus', { erasureId });
}

/** Stable exclusion hashes for a person, so a raw writer stores exactly what a writer computes. */
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

/** A raw ClickHouse insert, as a direct writer or a sink replica would issue it. */
function rawInsert(
  person: { profileId: string; anonymousId: string; userId: string },
  hashes: { profile: string; anonymous: string; user: string; version: string },
  eventId: string,
  extra = '',
) {
  const name = `Late ${eventId}`;
  return `INSERT INTO events
    (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, profile_id,
     properties, traits, context, consent, subject_profile, subject_anonymous, subject_user, subject_key_version, subject_coverage)
    SELECT toUUID(${sqlString(ws)}), ${sqlString(eventId)}, 'src_raw', toDateTime64(${sqlString(AT)}, 3, 'UTC'),
           toDateTime64(${sqlString(AT)}, 3, 'UTC'), 'track', ${sqlString(name)}, ${sqlString(person.anonymousId)},
           ${sqlString(person.userId)}, ${sqlString(person.profileId)}, '{}', '{}', '{}', map(),
           ${sqlString(hashes.profile)}, ${sqlString(hashes.anonymous)}, ${sqlString(hashes.user)}, ${sqlString(hashes.version)}, 'full'
    FROM numbers(1) ${extra}`;
}

async function ch(query: string, opts: { params?: Record<string, string>; signal?: AbortSignal } = {}) {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, value);
  const res = await fetch(url, { method: 'POST', body: query, ...(opts.signal ? { signal: opts.signal } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text;
}

/** A formatted insert, the only shape ClickHouse buffers for async_insert. */
async function chInsert(query: string, rows: Record<string, unknown>[], params: Record<string, string> = {}) {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  url.searchParams.set('query', query);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: 'POST',
    body: rows.map((row) => JSON.stringify(row)).join('\n'),
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text;
}

/** A base-table read: FINAL and the workspace setting, never a protected view. */
async function baseCount(table: string, where = '1'): Promise<number> {
  const rs = await t.srv.events.client.query({
    query: `SELECT count() AS n FROM ${table} FINAL WHERE workspace_id = {ws:UUID} AND ${where}`,
    query_params: { ws },
    format: 'JSONEachRow',
    clickhouse_settings: await t.srv.events.settingsFor(ws),
  });
  return Number((await rs.json<{ n: number }>())[0]?.n ?? 0);
}

/** Waits (deterministically) for a physical row to commit. */
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
  owner = await t.signUp(`contract-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}, 120_000);

afterAll(() => t?.close());

describe('erasure completion contract races (#1037 part 3)', () => {
  it('keeps a server-side insert that commits after the client timeout invisible', async () => {
    const person = await createPerson('held');
    const hashes = await hashesFor(person);
    await t.srv.events.insert([
      event({ name: 'Before', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
    ]);
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'held server insert' });
    // Publish and sweep first, then hold a raw server-side insert while the final pass completes.
    await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0, coverageWaitSeconds: 0 });
    await makeDue(erased.erasureId);

    // The insert sleeps on the server for five seconds; the client stops waiting after 200 ms. A
    // client timeout does not bound the server's commit, so the row can land after completion.
    const held = ch(rawInsert(person, hashes, 'held-server-side', 'WHERE sleepEachRow(1) = 0'));
    const timedOut = await Promise.race([held.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200))]);
    expect(timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await completeErasure(erased.erasureId);
    expect((await status(erased.erasureId)).status).toBe('complete');
    await held;
    await eventually(
      () => baseCount('events', "event_id = 'held-server-side'"),
      (count) => count === 1,
    );
    // The physical row exists, but every application read started after completion excludes it.
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
    expect((await status(erased.erasureId)).status).toBe('complete');
  }, 120_000);

  it('excludes an async insert that was buffered before completion and flushed afterwards', async () => {
    const person = await createPerson('buffered');
    const hashes = await hashesFor(person);
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'buffered async insert' });
    await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0, coverageWaitSeconds: 0 });
    await makeDue(erased.erasureId);

    // Buffer the row while the job is still pending, complete, then flush the async queue.
    await chInsert(
      'INSERT INTO events FORMAT JSONEachRow',
      [
        {
          workspace_id: ws,
          event_id: 'buffered-async',
          source_id: 'src_raw',
          received_at: AT.replace('T', ' ').replace('Z', ''),
          timestamp: AT.replace('T', ' ').replace('Z', ''),
          type: 'track',
          name: 'Late buffered-async',
          anonymous_id: person.anonymousId,
          user_id: person.userId,
          profile_id: person.profileId,
          properties: {},
          traits: {},
          context: {},
          consent: {},
          subject_profile: hashes.profile,
          subject_anonymous: hashes.anonymous,
          subject_user: hashes.user,
          subject_key_version: hashes.version,
          subject_coverage: 'full',
        },
      ],
      {
        async_insert: '1',
        wait_for_async_insert: '0',
        async_insert_busy_timeout_ms: '60000',
        async_insert_busy_timeout_min_ms: '60000',
        async_insert_busy_timeout_max_ms: '60000',
      },
    );
    await completeErasure(erased.erasureId);
    await ch('SYSTEM FLUSH ASYNC INSERT QUEUE');
    await eventually(
      () => baseCount('events', "event_id = 'buffered-async'"),
      (count) => count === 1,
    );
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
  }, 120_000);

  it('excludes every direct writer that resumes after a stale eligibility check', async () => {
    const person = await createPerson('direct');
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'stale eligibility' });
    await completeErasure(erased.erasureId);

    // These are the production writer entry points: each had, at some earlier point, a live profile
    // to check. They run after completion, as a resumed write would.
    await t.srv.events.insert([
      event({ name: 'Direct Event', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
    ]);
    await t.srv.events.insertMessageEvents([messageEvent({ profileId: person.profileId, type: 'delivered' })]);
    await t.srv.events.insertJourneyEvents([journeyEvent({ profileId: person.profileId, type: 'failed', node: 'send', seq: 2 })]);
    expect(await baseCount('events', "name = 'Direct Event'")).toBe(1);
    expect(await baseCount('message_events')).toBe(1);
    expect(await baseCount('journey_events')).toBe(1);

    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
    const stats = await t.srv.events.messageStats(ws, { since: new Date(FROM) });
    expect(stats.delivered ?? 0).toBe(0);
    expect(await t.srv.events.journeyCounts(ws, `jrn_contract_${stamp}`)).toEqual([]);
  }, 120_000);

  it('excludes two sink replicas with a redelivery under continuous ingest, and the erasure still completes', async () => {
    const person = await createPerson('replicas');
    const cleanup = erasedEventFilter({ db: t.srv.db, kp: t.srv.keyProvider, graceHours: t.srv.erasureGraceHours });
    const late = event({ name: 'Replica Event', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const insertStarted = new Promise<void>((resolve) => (started = resolve));
    let gate = true;
    const gated: EventStore = {
      ...t.srv.events,
      async insert(events) {
        if (gate) {
          gate = false;
          started();
          await held;
        }
        return t.srv.events.insert(events);
      },
    };
    const oneBatch = (events: BusEvent[]): EventBus => ({
      async consume(_opts, handler) {
        await handler(events);
      },
      async publish() {
        return { accepted: 0, duplicates: 0 };
      },
      async close() {},
    });

    // Replica 1 passes the tombstone filter before the erasure and stalls inside its insert.
    const replica1 = runSink(oneBatch([late]), gated, new AbortController().signal, { filter: cleanup });
    await insertStarted;
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'sink replicas' });
    // Replica 2 receives the redelivery after the erasure: its filter drops the batch.
    await runSink(oneBatch([late]), gated, new AbortController().signal, { filter: cleanup });

    // Continuous unrelated ingest must not livelock completion: no bus barrier is involved.
    let noisy = true;
    const noise = setInterval(() => {
      if (noisy) void t.srv.events.insert([event({ name: 'Noise', anonymousId: `noise-${sequence++}` })]).catch(() => {});
    }, 25);
    try {
      await runErasureCleanupOnce(cleanupDeps(), { finalSweepMs: 60_000, outboxWaitSeconds: 0, coverageWaitSeconds: 0 });
      await makeDue(erased.erasureId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await completeErasure(erased.erasureId);
      expect((await status(erased.erasureId)).status).toBe('complete');
      release();
      await replica1;
      await eventually(
        () => baseCount('events', "name = 'Replica Event'"),
        (count) => count === 1,
      );
      expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
    } finally {
      noisy = false;
      clearInterval(noise);
      release();
      await replica1.catch(() => {});
    }
  }, 120_000);

  it('excludes a write after an erasure transaction was held past the old sweep delay', async () => {
    const person = await createPerson('held-txn');
    const url = testDatabaseUrl(t.dbName);
    const blocker = new pg.Client({ connectionString: url.toString() });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      // The erasure command takes this exact session/transaction advisory lock before it reads the
      // person. Holding it models a transaction that started before, and committed long after, the
      // old sweep delay.
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`identity:${ws}`]);
      const erasing = t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'held erasure transaction' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query('COMMIT');
      const erased = await erasing;
      // The sweep interval used to be the only deadline; it cannot make this erasure complete early
      // or leave its later write excluded only by timing.
      await completeErasure(erased.erasureId, { finalSweepMs: 50 });
      await t.srv.events.insert([
        event({ name: 'Held Transaction Event', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
      ]);
      expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
    } finally {
      await blocker.end().catch(() => {});
    }
  }, 120_000);

  it('replays the ledger after a restore and reports the erasure correctly, still excluding its rows', async () => {
    const person = await createPerson('restore');
    await t.srv.events.insert([
      event({ name: 'Restored Event', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
    ]);
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'restore replay' });
    await completeErasure(erased.erasureId);

    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const log = await readErasureLog(databaseUrl);
    // A snapshot taken before the erasure still has the person; ClickHouse lost the exclusions,
    // because it is not part of the Postgres snapshot.
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, person.profileId]);
    await t.srv.db.admin.query(
      `INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, 'anonymous_id', $3)
       ON CONFLICT DO NOTHING`,
      [ws, person.profileId, person.anonymousId],
    );
    await t.srv.db.admin.query('DELETE FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [ws, erased.erasureId]);
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    await replayErasures(databaseUrl, log);

    const pending = await status(erased.erasureId);
    expect(pending.status).not.toBe('complete');
    expect(pending.reason).toBe('publication');
    await completeErasure(erased.erasureId);
    const complete = await status(erased.erasureId);
    expect(complete).toMatchObject({ status: 'complete', exclusion: 'full' });
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [] })).toEqual([]);
  }, 180_000);

  it('applies one completion to aggregates, exports, a pending-event union and the analytics cache', async () => {
    const person = await createPerson('readers');
    const live = await createPerson('readers-live');
    await t.srv.events.insert([
      event({ name: 'Purchase', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
      event({ name: 'Purchase', profileId: live.profileId, anonymousId: live.anonymousId, userId: live.userId }),
    ]);
    const query = {
      measures: ['conversions'],
      dimensions: [] as string[],
      from: FROM,
      to: TO,
      filters: { name: ['Purchase'] },
    };
    const api = t.api(owner, ws);
    // Cache the pre-erasure answer: the next post-completion read must not serve it.
    expect((await api.call('analytics.query', query)).rows).toEqual([[2]]);
    const erased = await api.call('profiles.erase', { profileId: person.profileId, reason: 'readers after completion' });
    await completeErasure(erased.erasureId);

    // Deliberately no clearAnalyticsCache(): the confirmed-publication epoch moved, so the cached
    // pre-erasure answer is unreachable even though a late row is written next.
    expect((await api.call('analytics.query', query)).rows).toEqual([[1]]);
    await t.srv.events.insert([
      event({ name: 'Purchase', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
    ]);
    expect((await api.call('analytics.query', query)).rows).toEqual([[1]]);
    const exported: Record<string, unknown>[] = [];
    for await (const page of readDataset({ db: t.srv.db, events: t.srv.events }, ws, 'events', FROM, TO)) exported.push(...page);
    expect(exported.map((row) => row.user_id)).not.toContain(person.userId);
    expect(exported.map((row) => row.user_id)).toContain(live.userId);

    const pending: MessageEvent[] = [
      messageEvent({ messageId: 'bct_pending_erased', journeyId: 'bct_pending_erased', profileId: person.profileId, type: 'sent' }),
      messageEvent({ messageId: 'bct_pending_live', journeyId: 'bct_pending_live', profileId: live.profileId, type: 'sent' }),
    ];
    const published = await t.srv.events.messageStats(ws, { since: new Date(FROM) });
    const withPending = await t.srv.events.messageStats(ws, { since: new Date(FROM), pendingEvents: pending });
    expect(withPending.sent).toBe((published.sent ?? 0) + 1);
  }, 180_000);

  it('reports physical purge separately from logical completion and keeps the selectors', async () => {
    const person = await createPerson('purge');
    const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'purge status' });
    await completeErasure(erased.erasureId);
    const before = await status(erased.erasureId);
    expect(before).toMatchObject({ status: 'complete', purge: { state: expect.stringMatching(/pending|running|done/) } });
    // A late row is physically present and must be swept by the recurring purge, not by completion.
    await t.srv.events.insert([
      event({ name: 'Purge Event', profileId: person.profileId, anonymousId: person.anonymousId, userId: person.userId }),
    ]);
    expect(await baseCount('events', "name = 'Purge Event'")).toBe(1);
    const purged = await runErasurePurgeOnce({ db: t.srv.db, events: t.srv.events }, { batchSize: 100 });
    expect(purged.claimed).toBeGreaterThanOrEqual(1);
    expect(await baseCount('events', "name = 'Purge Event'")).toBe(0);
    expect((await status(erased.erasureId)).purge.state).toBe('done');
    // The ledger and published exclusions are the selectors the purge still needs.
    const keys = await t.srv.db.admin.query('SELECT count(*)::int AS n FROM erasure_keys WHERE workspace_id = $1', [ws]);
    expect(keys.rows[0]?.n).toBeGreaterThan(0);
    expect((await t.srv.events.erasedSubjectKeys(ws)).size).toBeGreaterThan(0);
  }, 180_000);
});
