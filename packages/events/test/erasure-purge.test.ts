import { createHmac } from 'node:crypto';
import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runScoped } from '../../db/test/run';
import {
  type BusEvent,
  clickHouseStore,
  type EventStore,
  type JourneyEvent,
  type MessageEvent,
  migrateClickHouse,
  resetClickHouse,
  type SubjectKeyHasher,
  type SubjectKeyKind,
} from '../src';

// #1037 part 3: the recurring physical purge deletes stored rows whose effective subject keys
// match a retained exclusion key, in bounded batches. It uses the same keyed matching as the
// protected views, including a profile id through its hash or the identity-keyed side entry, and it
// never touches the exclusion state it needs.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_erasure_purge');
const ws = newUuid();
const KEY = Buffer.alloc(32, 17);
const VERSION = 'dk_exclusion_purge';

const hmac = (kind: SubjectKeyKind, value: string) => createHmac('sha256', KEY).update(`${kind}:${value}`).digest('hex');
const hasher: SubjectKeyHasher = {
  version: VERSION,
  async hash(kind, value) {
    return hmac(kind, value);
  },
  dispose() {},
};
const factory = async () => hasher;

let store: EventStore;

const event = (i: number, over: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_purge',
  messageId: `purge-${i}`,
  type: 'track',
  name: 'Purge Event',
  anonymousId: `purge-anon-${i}`,
  userId: `purge-user-${i}`,
  profileId: `prf_purge_${i}`,
  timestamp: new Date(Date.UTC(2026, 10, 12, 12, 0, i)).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 10, 12, 12, 0, i)).toISOString(),
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const messageEvent = (i: number, over: Partial<MessageEvent> = {}): MessageEvent => ({
  workspaceId: ws,
  messageId: `purge-msg-${i}`,
  eventId: `purge-me-${i}`,
  type: 'delivered',
  at: new Date(Date.UTC(2026, 10, 12, 12, 0, i)).toISOString(),
  profileId: `prf_purge_msg_${i}`,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: 'eml_purge',
  templateVersion: 1,
  journeyId: 'bct_purge',
  reason: '',
  url: '',
  ...over,
});

const journeyEvent = (i: number, over: Partial<JourneyEvent> = {}): JourneyEvent => ({
  workspaceId: ws,
  journeyId: 'jrn_purge',
  version: 1,
  participantId: i,
  profileId: `prf_purge_jrn_${i}`,
  node: 'start',
  type: 'entered',
  seq: i,
  at: new Date(Date.UTC(2026, 10, 12, 12, 0, i)).toISOString(),
  detail: '',
  ...over,
});

async function rows<T>(query: string, params: Record<string, unknown> = {}, workspace = ws): Promise<T[]> {
  const settings = await store.settingsFor(workspace);
  const rs = await store.client.query({
    query,
    query_params: { ws: workspace, ...params },
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  return rs.json<T>();
}

const count = async (table: string) => Number((await rows<{ n: number | string }>(`SELECT count() AS n FROM ${table} FINAL`))[0]?.n ?? 0);

/**
 * Publishes a workspace's exclusion keys, as the erasure cleanup does before a sweep. Protected
 * reads hide a matching row through these rows; the physical purge reads the key list its caller
 * passes, not this table.
 */
async function publish(target: EventStore, workspaceId: string, keys: readonly string[]) {
  await target.publishErasedSubjects(
    keys.map((key, index) => ({
      workspaceId,
      kind: 'profile' as SubjectKeyKind,
      key,
      keyVersion: VERSION,
      erasureId: `era_purge_${index}`,
      generation: 1,
      recordedAt: new Date().toISOString(),
    })),
  );
}

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
}, 60_000);

afterAll(async () => {
  await store?.close();
});

describe('recurring physical purge (#1037 part 3)', () => {
  it('deletes only matching rows across all three person tables and keeps the exclusion state', async () => {
    await store.insert([event(1), event(2)]);
    await store.insertMessageEvents([
      messageEvent(1),
      messageEvent(2, { messageId: 'purge-msg-live', eventId: 'purge-me-live', profileId: 'prf_live_msg' }),
    ]);
    await store.insertJourneyEvents([journeyEvent(1), journeyEvent(2, { participantId: 2, profileId: 'prf_live_jrn' })]);

    const keys = [hmac('profile', 'prf_purge_1'), hmac('profile', 'prf_purge_msg_1'), hmac('profile', 'prf_purge_jrn_1')];
    await store.publishErasedSubjects(
      keys.map((key, index) => ({
        workspaceId: ws,
        kind: 'profile',
        key,
        keyVersion: VERSION,
        erasureId: `era_purge_${index}`,
        generation: 1,
        recordedAt: new Date().toISOString(),
      })),
    );

    const result = await store.purgeErasedSubjects(ws, keys, { batchSize: 100 });
    expect(result.complete).toBe(true);
    expect(result.deleted).toBe(3);

    expect(await count('events')).toBe(1);
    expect(await count('message_events')).toBe(1);
    expect(await count('journey_events')).toBe(1);
    // The purge never deletes the selectors it needs: published exclusions survive it.
    expect(await count('erased_subjects')).toBe(3);
    expect(await store.eventsOf(ws, { anonymousIds: ['purge-anon-2'], userIds: [] })).toHaveLength(1);
  }, 60_000);

  it('matches the committed PostgreSQL keys, not every exclusion ClickHouse has published', async () => {
    const authorityWs = newUuid();
    const committedProfile = 'prf_authority_committed';
    const publishedOnlyProfile = 'prf_authority_published_only';
    await store.insert([
      event(1, { workspaceId: authorityWs, profileId: committedProfile, anonymousId: '', userId: '' }),
      event(2, { workspaceId: authorityWs, profileId: publishedOnlyProfile, anonymousId: '', userId: '' }),
    ]);
    const committed = hmac('profile', committedProfile);
    const publishedOnly = hmac('profile', publishedOnlyProfile);
    // ClickHouse still holds a key from an older publication that PostgreSQL never committed for
    // this workspace: it must not choose what the sweep deletes. The committed key is deliberately
    // absent from ClickHouse, so only the PostgreSQL list can find its row.
    await publish(store, authorityWs, [publishedOnly]);
    const result = await store.purgeErasedSubjects(authorityWs, [committed], { batchSize: 10 });
    expect(result).toMatchObject({ complete: true, deleted: 1 });
    expect(await rows<{ profile_id: string }>('SELECT profile_id FROM events FINAL', {}, authorityWs)).toEqual([
      { profile_id: publishedOnlyProfile },
    ]);
  }, 60_000);

  it('matches events.profile_id through the keyed side entry, never a raw id', async () => {
    const legacyWs = newUuid();
    const legacy = (name: string, profileId: string) => ({
      workspace_id: legacyWs,
      event_id: `legacy-purge-${name}`,
      source_id: 'src_legacy_purge',
      received_at: '2026-08-01 12:00:00',
      timestamp: '2026-08-01 12:00:00',
      type: 'track',
      name,
      anonymous_id: '',
      user_id: '',
      profile_id: profileId,
      properties: {},
      traits: {},
      context: {},
      consent: {},
    });
    await store.client.insert({
      table: 'events',
      values: [legacy('Erased', 'prf_legacy_erased'), legacy('Live', 'prf_legacy_live')],
      format: 'JSONEachRow',
    });
    let step = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    for (let i = 0; i < 4 && !step.done; i++) step = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    expect(step.done).toBe(true);

    // The raw profile id is not retained anywhere in the purge's input: only its exclusion hash is.
    const key = hmac('profile', 'prf_legacy_erased');
    await publish(store, legacyWs, [key]);
    expect(key).not.toContain('prf_legacy_erased');
    const result = await store.purgeErasedSubjects(legacyWs, [key], { batchSize: 10 });
    expect(result).toMatchObject({ complete: true, deleted: 2 });
    expect(await rows<{ name: string }>('SELECT name FROM events FINAL', {}, legacyWs)).toEqual([{ name: 'Live' }]);
    // The side entry is keyed by the raw identity, so it must go with the base row: it is otherwise
    // the last raw trace of the erased person.
    expect(
      await rows<{ key4: string }>(
        `SELECT key4 FROM subject_key_backfill FINAL
          WHERE workspace_id = {ws:UUID} AND table_name = 'events' AND key4 = {id:String}`,
        { id: 'legacy-purge-Erased' },
        legacyWs,
      ),
    ).toEqual([]);

    // A later redelivery of the same legacy row re-backfills harmlessly: the next purge removes the
    // base row and its side entry again, and the protected read never resurrects the person.
    await store.client.insert({ table: 'events', values: [legacy('Erased', 'prf_legacy_erased')], format: 'JSONEachRow' });
    let again = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    for (let i = 0; i < 4 && !again.done; i++) again = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    expect(again.done).toBe(true);
    expect(
      await rows<{ key4: string }>(
        `SELECT key4 FROM subject_key_backfill FINAL
          WHERE workspace_id = {ws:UUID} AND table_name = 'events' AND key4 = {id:String}`,
        { id: 'legacy-purge-Erased' },
        legacyWs,
      ),
    ).toEqual([{ key4: 'legacy-purge-Erased' }]);
    expect(await store.purgeErasedSubjects(legacyWs, [key], { batchSize: 10 })).toMatchObject({ complete: true, deleted: 2 });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL', {}, legacyWs)).toEqual([{ n: 1 }]);
    expect(
      await rows<{ key4: string }>(
        `SELECT key4 FROM subject_key_backfill FINAL
          WHERE workspace_id = {ws:UUID} AND table_name = 'events' AND key4 = {id:String}`,
        { id: 'legacy-purge-Erased' },
        legacyWs,
      ),
    ).toEqual([]);
  }, 60_000);

  it('keeps a side entry until its base row is gone when the batch bound stops the sweep', async () => {
    const boundedWs = newUuid();
    const legacy = (id: string) => ({
      workspace_id: boundedWs,
      event_id: id,
      source_id: 'src_bounded_side',
      received_at: '2026-08-02 12:00:00',
      timestamp: '2026-08-02 12:00:00',
      type: 'track',
      name: 'Bounded',
      anonymous_id: '',
      user_id: '',
      profile_id: 'prf_bounded_side',
      properties: {},
      traits: {},
      context: {},
      consent: {},
    });
    await store.client.insert({ table: 'events', values: [legacy('one'), legacy('two')], format: 'JSONEachRow' });
    let step = await store.backfillSubjectKeys({ workspaceIds: [boundedWs], batchSize: 10 });
    for (let i = 0; i < 4 && !step.done; i++) step = await store.backfillSubjectKeys({ workspaceIds: [boundedWs], batchSize: 10 });
    expect(step.done).toBe(true);

    const key = hmac('profile', 'prf_bounded_side');
    await publish(store, boundedWs, [key]);
    const first = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 1, maxBatches: 1 });
    expect(first).toMatchObject({ complete: false });
    // One base row remains, so both side entries stay: removing one would make its row visible.
    expect(
      await rows<{ n: number }>("SELECT count() AS n FROM subject_key_backfill FINAL WHERE table_name = 'events'", {}, boundedWs),
    ).toEqual([{ n: 2 }]);

    const second = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 10, maxBatches: 2 });
    expect(second).toMatchObject({ complete: true });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL', {}, boundedWs)).toEqual([{ n: 0 }]);
    expect(
      await rows<{ n: number }>("SELECT count() AS n FROM subject_key_backfill FINAL WHERE table_name = 'events'", {}, boundedWs),
    ).toEqual([{ n: 0 }]);
  }, 60_000);

  it('keeps the side entry a late legacy row depends on, instead of reopening its exclusion', async () => {
    const raceWs = newUuid();
    const legacy = (name: string, eventId: string): Record<string, unknown> => ({
      workspace_id: raceWs,
      event_id: eventId,
      source_id: 'src_side_race',
      received_at: '2026-08-03 12:00:00',
      timestamp: '2026-08-03 12:00:00',
      type: 'track',
      name,
      anonymous_id: '',
      user_id: '',
      profile_id: 'prf_side_race',
      properties: {},
      traits: {},
      context: {},
      consent: {},
    });
    // `side-a` backs the row this sweep deletes. `side-b` outlives its base row (an earlier pass
    // removed it without the side entry), so it is the only thing that can exclude a late
    // redelivery of that legacy row.
    await store.client.insert({ table: 'events', values: [legacy('Side race A', 'side-race-a')], format: 'JSONEachRow' });
    let step = await store.backfillSubjectKeys({ workspaceIds: [raceWs], batchSize: 10 });
    for (let i = 0; i < 4 && !step.done; i++) step = await store.backfillSubjectKeys({ workspaceIds: [raceWs], batchSize: 10 });
    expect(step.done).toBe(true);
    const profileKey = hmac('profile', 'prf_side_race');
    await publish(store, raceWs, [profileKey]);
    await store.client.insert({
      table: 'subject_key_backfill',
      format: 'JSONEachRow',
      values: [
        {
          workspace_id: raceWs,
          table_name: 'events',
          key1: 'Side race B',
          key2: '',
          key3: '2026-08-03 12:00:00.000',
          key4: 'side-race-b',
          subject_profile: profileKey,
          subject_key_version: VERSION,
          subject_coverage: 'ids_only',
          version: 1,
        },
      ],
    });

    let checks = 0;
    const result = await store.purgeErasedSubjects(raceWs, [profileKey], {
      batchSize: 100,
      maxBatches: 2,
      checkpoint: async () => {
        checks++;
        // The first checkpoint is the staged load and the second the base-table delete. The third is
        // the side-table batch, after the base table reached zero. A late legacy row arrives now: it
        // has no subject keys of its own and depends on `side-b`.
        if (checks === 3)
          await store.client.insert({ table: 'events', values: [legacy('Side race B', 'side-race-b')], format: 'JSONEachRow' });
        return true;
      },
    });

    expect(result).toMatchObject({ complete: false });
    expect(result.tables.find((table) => table.table === 'events')).toEqual({ table: 'events', deleted: 2, remaining: true });
    // The late row is still there, and the side entry that excludes it was kept.
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, raceWs)).toEqual([
      { n: 1 },
    ]);
    expect(
      await rows<{ key4: string }>(
        `SELECT key4 FROM subject_key_backfill FINAL
          WHERE workspace_id = {ws:UUID} AND table_name = 'events' ORDER BY key4`,
        {},
        raceWs,
      ),
    ).toEqual([{ key4: 'side-race-b' }]);
  }, 60_000);

  it('purges more than a thousand rows in several bounded batches within the HTTP parameter limit', async () => {
    const bulkWs = newUuid();
    const total = 1_500;
    // Real-shaped identities are what makes a 1,000-row tuple list exceed ClickHouse's per-field
    // HTTP limit: a long event name, a long anonymous id, a timestamp and an event id per row.
    await store.insert(
      Array.from({ length: total }, (_, i) =>
        event(i, {
          workspaceId: bulkWs,
          profileId: 'prf_bulk_purge',
          name: `Purge event with a realistic name ${i}`,
          anonymousId: `bulk-${String(i).padStart(4, '0')}-${'a'.repeat(32)}`,
        }),
      ),
    );
    const key = hmac('profile', 'prf_bulk_purge');
    await publish(store, bulkWs, [key]);
    let deletes = 0;
    const result = await store.purgeErasedSubjects(bulkWs, [key], {
      maxBatches: 10,
      checkpoint: async () => {
        deletes++;
        return true;
      },
    });
    // Every delete stays under the server's per-field limit, so the sweep neither fails nor retries
    // forever; it takes more than one request to cover 1,500 rows.
    expect(deletes).toBeGreaterThan(1);
    expect(result).toMatchObject({ complete: true, deleted: total });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, bulkWs)).toEqual([
      { n: 0 },
    ]);
  }, 120_000);

  it('sweeps a workspace whose committed ledger is larger than one query parameter and one staged batch', async () => {
    const ledgerWs = newUuid();
    const total = 3_200;
    // A ledger this size is ordinary for a long-lived person. Bound as one `Array(String)`, it is
    // over ClickHouse's 128 KiB field limit and every count, batch select and delete failed, so the
    // physical purge could never make progress. It is also over one staged insert's bound, so the
    // load itself must be split.
    const anonymousIds = Array.from({ length: total }, (_, i) => `ledger-${String(i).padStart(4, '0')}-${'k'.repeat(40)}`);
    const keys = anonymousIds.map((id) => hmac('anonymous_id', id));
    await publish(store, ledgerWs, keys);
    await store.insert([event(0, { workspaceId: ledgerWs, anonymousId: anonymousIds[0], userId: '', profileId: '' })]);

    const originalInsert = store.client.insert.bind(store.client);
    const staged: number[] = [];
    store.client.insert = (async (args) => {
      if ((args as unknown as { table?: string }).table === 'erasure_purge_keys')
        staged.push(((args as unknown as { values?: readonly unknown[] }).values ?? []).length);
      return originalInsert(args);
    }) as typeof store.client.insert;
    let result: Awaited<ReturnType<typeof store.purgeErasedSubjects>>;
    try {
      result = await store.purgeErasedSubjects(ledgerWs, keys, { batchSize: 100 });
    } finally {
      store.client.insert = originalInsert;
    }
    expect(staged.length).toBeGreaterThan(1);
    expect(Math.max(...staged)).toBeLessThanOrEqual(2_000);
    expect(staged.reduce((sum, rows) => sum + rows, 0)).toBe(total);
    expect(result).toMatchObject({ complete: true, deleted: 1 });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, ledgerWs)).toEqual([
      { n: 0 },
    ]);
    // The purge never deletes the exclusions it matched, and it drops its own staged run.
    expect(
      await rows<{ n: number }>('SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}', {}, ledgerWs),
    ).toEqual([{ n: total }]);
    expect(await rows<{ n: number }>('SELECT count() AS n FROM erasure_purge_keys WHERE workspace_id = {ws:UUID}', {}, ledgerWs)).toEqual([
      { n: 0 },
    ]);
  }, 120_000);

  it('bounds a staged batch by the encoded rows as well as the row count', async () => {
    const limit = 256 * 1024;
    const capture = async (target: string, keys: string[]) => {
      const batches: { rows: number; bytes: number }[] = [];
      const originalInsert = store.client.insert.bind(store.client);
      store.client.insert = (async (args) => {
        const insert = args as unknown as { table?: string; values?: readonly Record<string, unknown>[] };
        if (insert.table === 'erasure_purge_keys') {
          const values = insert.values ?? [];
          batches.push({
            rows: values.length,
            bytes: values.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8') + 1, 0),
          });
        }
        return originalInsert(args);
      }) as typeof store.client.insert;
      try {
        await store.purgeErasedSubjects(target, keys, { batchSize: 10 });
      } finally {
        store.client.insert = originalInsert;
      }
      return batches;
    };

    // Short keys reach the row bound first: the first batch fills to 2,000 rows and the rest follows.
    const rowsFirst = await capture(
      newUuid(),
      Array.from({ length: 2_001 }, (_, i) => `k${i}`),
    );
    expect(rowsFirst[0]?.rows).toBe(2_000);
    expect(rowsFirst.reduce((sum, batch) => sum + batch.rows, 0)).toBe(2_001);

    // A normal key is 64 hex characters. The workspace and run id repeated in every encoded row and
    // the JSON quoting are most of the line, so 2,000 of them exceed the byte budget even though the
    // row count is still under its bound: the estimate must count the whole serialized row.
    const hex = Array.from({ length: 1_900 }, (_, i) => hmac('anonymous_id', `encoded-${i}-${'e'.repeat(40)}`));
    const bytesFirst = await capture(newUuid(), hex);
    expect(bytesFirst.length).toBeGreaterThan(1);
    expect(Math.max(...bytesFirst.map((batch) => batch.rows))).toBeLessThan(2_000);
    expect(bytesFirst.reduce((sum, batch) => sum + batch.rows, 0)).toBe(1_900);
    for (const batch of [...rowsFirst, ...bytesFirst]) {
      expect(batch.rows).toBeLessThanOrEqual(2_000);
      expect(batch.bytes).toBeLessThanOrEqual(limit);
    }
  }, 120_000);

  it('stages its key set through the configured client and never bypasses it', async () => {
    const clientWs = newUuid();
    const anonymousId = `client-stage-${'c'.repeat(40)}`;
    const key = hmac('anonymous_id', anonymousId);
    await store.insert([event(0, { workspaceId: clientWs, anonymousId, userId: '', profileId: '' })]);

    // A request that did not go through the configured client would have to use fetch. The store's
    // client carries the configured database, path, credentials and settings, so anything else is
    // a bypass.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the purge must use the configured ClickHouse client');
    });
    const originalInsert = store.client.insert.bind(store.client);
    const inserted: { table: string; rows: number }[] = [];
    store.client.insert = (async (args) => {
      const insert = args as unknown as { table?: string; values?: readonly unknown[] };
      inserted.push({ table: insert.table ?? '', rows: (insert.values ?? []).length });
      return originalInsert(args);
    }) as typeof store.client.insert;
    const originalQuery = store.client.query.bind(store.client);
    const queries: { sql: string; settings: Record<string, unknown> }[] = [];
    store.client.query = (async (args) => {
      const query = args as { query: string; clickhouse_settings?: Record<string, unknown> };
      queries.push({ sql: query.query, settings: query.clickhouse_settings ?? {} });
      return originalQuery(args);
    }) as typeof store.client.query;
    try {
      expect(await store.purgeErasedSubjects(clientWs, [key], { batchSize: 100 })).toMatchObject({ complete: true, deleted: 1 });
    } finally {
      store.client.insert = originalInsert;
      store.client.query = originalQuery;
      fetchSpy.mockRestore();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserted).toContainEqual({ table: 'erasure_purge_keys', rows: 1 });
    // Every matching read names this run's staged set in the configured database.
    const matching = queries.filter((query) => query.sql.includes('FROM erasure_purge_keys'));
    expect(matching.length).toBeGreaterThan(0);
    for (const query of matching) {
      expect(query.sql).toContain('workspace_id = {ws:UUID}');
      expect(query.sql).toContain('run_id = {run:String}');
    }
    // The staged rows are gone afterwards, which also shows they landed in the configured database.
    expect(await rows<{ n: number }>('SELECT count() AS n FROM erasure_purge_keys WHERE workspace_id = {ws:UUID}', {}, clientWs)).toEqual([
      { n: 0 },
    ]);
  }, 60_000);

  it('bounds every purge statement on the server as well as the client', async () => {
    const boundWs = newUuid();
    const key = hmac('anonymous_id', 'bounded-statement');
    await store.insert([event(0, { workspaceId: boundWs, anonymousId: 'bounded-statement', userId: '', profileId: '' })]);
    const originalQuery = store.client.query.bind(store.client);
    const readBounds: unknown[] = [];
    store.client.query = (async (args) => {
      const query = args as { query: string; clickhouse_settings?: Record<string, unknown> };
      if (query.query.includes('SELECT count() AS n FROM events')) readBounds.push(query.clickhouse_settings?.max_execution_time);
      return originalQuery(args);
    }) as typeof store.client.query;
    const originalCommand = store.client.command.bind(store.client);
    const deleteBounds: unknown[] = [];
    store.client.command = (async (args) => {
      const command = args as { query: string; clickhouse_settings?: Record<string, unknown> };
      if (command.query.includes('DELETE FROM events')) deleteBounds.push(command.clickhouse_settings?.max_execution_time);
      return originalCommand(args);
    }) as typeof store.client.command;
    try {
      expect(await store.purgeErasedSubjects(boundWs, [key], { batchSize: 100 })).toMatchObject({ complete: true, deleted: 1 });
    } finally {
      store.client.query = originalQuery;
      store.client.command = originalCommand;
    }
    expect(readBounds.length).toBeGreaterThan(0);
    expect(deleteBounds.length).toBeGreaterThan(0);
    // 30 s: the same bound as the client's request timeout.
    expect([...readBounds, ...deleteBounds].every((value) => value === 30)).toBe(true);
  }, 60_000);

  it('bounds the side-table guard read on the server too', async () => {
    const guardWs = newUuid();
    const key = hmac('profile', 'prf_guard_bound');
    await publish(store, guardWs, [key]);
    // An orphaned side entry sends the sweep through `existingBaseIds`, the guard that decides
    // whether a side entry still backs a base row.
    await store.client.insert({
      table: 'subject_key_backfill',
      format: 'JSONEachRow',
      values: [
        {
          workspace_id: guardWs,
          table_name: 'events',
          key1: 'Guard bound',
          key2: 'guard-anon',
          key3: '2026-08-05 12:00:00.000',
          key4: 'guard-bound',
          subject_profile: key,
          subject_key_version: VERSION,
          subject_coverage: 'ids_only',
          version: 1,
        },
      ],
    });
    const originalQuery = store.client.query.bind(store.client);
    const guardBounds: unknown[] = [];
    store.client.query = (async (args) => {
      const query = args as { query: string; clickhouse_settings?: Record<string, unknown> };
      if (query.query.includes("subject_coverage != 'full'")) guardBounds.push(query.clickhouse_settings?.max_execution_time);
      return originalQuery(args);
    }) as typeof store.client.query;
    try {
      expect(await store.purgeErasedSubjects(guardWs, [key], { batchSize: 100 })).toMatchObject({ complete: true, deleted: 1 });
    } finally {
      store.client.query = originalQuery;
    }
    expect(guardBounds.length).toBeGreaterThan(0);
    expect(guardBounds.every((value) => value === 30)).toBe(true);
  }, 60_000);

  it('stops the sweep when its caller aborts while the key set is staging', async () => {
    const abortWs = newUuid();
    const keys = Array.from({ length: 2_500 }, (_, i) => hmac('anonymous_id', `staged-abort-${i}-${'a'.repeat(40)}`));
    const abort = new AbortController();
    const isolated = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: factory,
      signal: abort.signal,
      queryIdPrefix: 'purge-abort-',
    });
    try {
      const realInsert = isolated.client.insert.bind(isolated.client);
      const stages: { queryId: string | undefined; signal: AbortSignal | undefined }[] = [];
      isolated.client.insert = (async (args) => {
        const insert = args as { table?: string; query_id?: string; abort_signal?: AbortSignal };
        const result = await realInsert(args);
        if (insert.table === 'erasure_purge_keys') {
          stages.push({ queryId: insert.query_id, signal: insert.abort_signal });
          // The restore loses its lock after the first staged batch landed.
          abort.abort(new Error('the sweep was cancelled'));
        }
        return result;
      }) as typeof isolated.client.insert;
      const realQuery = isolated.client.query.bind(isolated.client);
      let purgeReads = 0;
      isolated.client.query = (async (args) => {
        if (String((args as { query?: string }).query).includes('FROM events AS t FINAL')) purgeReads += 1;
        return realQuery(args);
      }) as typeof isolated.client.query;
      await expect(isolated.purgeErasedSubjects(abortWs, keys, { batchSize: 10 })).rejects.toThrow(/sweep was cancelled/);
      // The staging inserts carry the store's signal and query-id marker like every other request,
      // and no purge read follows the abort.
      expect(stages).toHaveLength(1);
      expect(stages[0]?.signal).toBe(abort.signal);
      expect(stages[0]?.queryId).toMatch(/^purge-abort-/);
      expect(purgeReads).toBe(0);
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it('accepts only one non-negative integer as a count answer', async () => {
    const attempt = async (answer: unknown) => {
      const countWs = newUuid();
      const anonymousId = 'strict-count-anon';
      const key = hmac('anonymous_id', anonymousId);
      await store.insert([event(0, { workspaceId: countWs, anonymousId, userId: '', profileId: '' })]);
      const originalQuery = store.client.query.bind(store.client);
      store.client.query = (async (args) => {
        const query = args as { query: string };
        // Only the events table gets the shape under test; the other tables answer normally.
        if (query.query.includes('SELECT count() AS n FROM events AS t FINAL'))
          return { json: async () => answer } as Awaited<ReturnType<typeof originalQuery>>;
        return originalQuery(args);
      }) as typeof store.client.query;
      try {
        return { workspaceId: countWs, result: await store.purgeErasedSubjects(countWs, [key], { batchSize: 10 }) };
      } catch (error) {
        return { workspaceId: countWs, error: error as Error };
      } finally {
        store.client.query = originalQuery;
      }
    };

    // ClickHouse sends UInt64 as a decimal string by default; a JSON number is accepted too.
    for (const answer of [[{ n: 0 }], [{ n: 7 }], [{ n: '0' }], [{ n: '42' }]]) {
      expect((await attempt(answer)).error).toBeUndefined();
    }

    // Every other shape is a broken answer, never an empty table: a missing row, more than one row
    // (even if the first is zero), a boolean, whitespace, a sign, a fraction, hex or exponent.
    for (const answer of [
      [],
      [{ n: 1 }, { n: 1 }],
      [{ n: 0 }, { n: 0 }],
      [{}],
      [{ n: false }],
      [{ n: true }],
      [{ n: '' }],
      [{ n: ' ' }],
      [{ n: '1 ' }],
      [{ n: '-1' }],
      [{ n: '+1' }],
      [{ n: '1e3' }],
      [{ n: '1.5' }],
      [{ n: '0x10' }],
      [{ n: 1.5 }],
      [{ n: -1 }],
      [{ n: null }],
      [{ n: undefined }],
      // Long server output is scanned without a backtracking pattern, and a value past the safe
      // integer range is still not a count.
      [{ n: '9'.repeat(400) }],
      [{ n: `1${'0'.repeat(400)}` }],
    ]) {
      const { workspaceId, error } = await attempt(answer);
      expect(error?.message).toMatch(/count .*for events/);
      // Nothing was deleted, and the failed sweep still dropped its staged run.
      expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, workspaceId)).toEqual([
        { n: 1 },
      ]);
      expect(
        await rows<{ n: number }>('SELECT count() AS n FROM erasure_purge_keys WHERE workspace_id = {ws:UUID}', {}, workspaceId),
      ).toEqual([{ n: 0 }]);
    }
  }, 120_000);

  it('propagates a ClickHouse failure instead of reporting a completed purge', async () => {
    const errorWs = newUuid();
    const anonymousId = 'client-error-anon';
    const key = hmac('anonymous_id', anonymousId);
    await store.insert([event(0, { workspaceId: errorWs, anonymousId, userId: '', profileId: '' })]);
    const originalQuery = store.client.query.bind(store.client);
    store.client.query = (async (args) => {
      const query = args as { query: string };
      if (query.query.includes('SELECT count() AS n FROM events AS t FINAL')) throw new Error('Code: 47. DB::Exception: Missing columns');
      return originalQuery(args);
    }) as typeof store.client.query;
    try {
      await expect(store.purgeErasedSubjects(errorWs, [key], { batchSize: 10 })).rejects.toThrow(/Code: 47/);
    } finally {
      store.client.query = originalQuery;
    }
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, errorWs)).toEqual([
      { n: 1 },
    ]);
  }, 60_000);

  it('measures non-ASCII and escaped identities in URL-encoded bytes, not characters', async () => {
    const wideWs = newUuid();
    const total = 400;
    // CJK text is three UTF-8 bytes and nine bytes percent-encoded per character, and quotes and
    // backslashes are escaped before encoding; counting characters let a batch reach 261 KB.
    await store.insert(
      Array.from({ length: total }, (_, i) =>
        event(i, {
          workspaceId: wideWs,
          profileId: 'prf_wide_purge',
          name: `購入完了イベント「${i}」 \\ 'quoted' ${'漢字'.repeat(20)}`,
          anonymousId: `wide-${i}-${'é'.repeat(30)}`,
        }),
      ),
    );
    const key = hmac('profile', 'prf_wide_purge');
    await publish(store, wideWs, [key]);
    const result = await store.purgeErasedSubjects(wideWs, [key], { maxBatches: 10 });
    expect(result).toMatchObject({ complete: true, deleted: total });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, wideWs)).toEqual([
      { n: 0 },
    ]);
  }, 120_000);

  it('removes an orphaned side entry for each table, whose identity is narrower than four keys', async () => {
    const sideWs = newUuid();
    const key = hmac('profile', 'prf_orphan_side');
    await publish(store, sideWs, [key]);
    // No base row exists for any of these, so each table goes straight to its side cleanup. A
    // message event's identity is three columns, while the side table always keeps four keys.
    await store.client.insert({
      table: 'subject_key_backfill',
      format: 'JSONEachRow',
      values: [
        {
          workspace_id: sideWs,
          table_name: 'events',
          key1: 'Orphan event',
          key2: 'orphan-anon',
          key3: '2026-08-04 12:00:00.000',
          key4: 'orphan-events',
          subject_profile: key,
          subject_key_version: VERSION,
          subject_coverage: 'ids_only',
          version: 1,
        },
        {
          workspace_id: sideWs,
          table_name: 'message_events',
          key1: 'orphan-message',
          key2: 'delivered',
          key3: 'orphan-message-event',
          key4: '',
          subject_profile: key,
          subject_key_version: VERSION,
          subject_coverage: 'ids_only',
          version: 1,
        },
        {
          workspace_id: sideWs,
          table_name: 'journey_events',
          key1: 'orphan-journey',
          key2: '7',
          key3: '3',
          key4: 'entered',
          subject_profile: key,
          subject_key_version: VERSION,
          subject_coverage: 'ids_only',
          version: 1,
        },
      ],
    });

    const result = await store.purgeErasedSubjects(sideWs, [key], { batchSize: 100 });
    expect(result).toMatchObject({ complete: true, deleted: 3 });
    expect(
      await rows<{ n: number }>('SELECT count() AS n FROM subject_key_backfill FINAL WHERE workspace_id = {ws:UUID}', {}, sideWs),
    ).toEqual([{ n: 0 }]);
  }, 60_000);

  it('stops at the batch bound and reports that a later round must continue', async () => {
    const boundedWs = newUuid();
    await store.insert(
      [0, 1, 2, 3, 4].map((i) => event(i, { workspaceId: boundedWs, profileId: 'prf_bounded', anonymousId: `bounded-${i}` })),
    );
    const key = hmac('profile', 'prf_bounded');
    await publish(store, boundedWs, [key]);
    const first = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ deleted: 2, complete: false });
    expect(first.tables.find((table) => table.table === 'events')).toMatchObject({ deleted: 2, remaining: true });
    const second = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 10, maxBatches: 2 });
    expect(second).toMatchObject({ deleted: 3, complete: true });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL', {}, boundedWs)).toEqual([{ n: 0 }]);
  }, 60_000);

  it('measures progress after the delete, so a write that lands mid-batch keeps the table open', async () => {
    const lateWs = newUuid();
    await store.insert([event(1, { workspaceId: lateWs, profileId: 'prf_observed', anonymousId: 'observed-1' })]);
    const key = hmac('profile', 'prf_observed');
    await publish(store, lateWs, [key]);
    let wroteLate = false;
    const result = await store.purgeErasedSubjects(lateWs, [key], {
      batchSize: 1,
      maxBatches: 1,
      checkpoint: async () => {
        if (!wroteLate) {
          wroteLate = true;
          // The checkpoint runs after the fixed batch was selected and before its delete. A write
          // here is not in that batch, so the delete still removes one row while the table's count
          // stays the same: `deleted` must report the batch, not the net change.
          await store.insert([event(2, { workspaceId: lateWs, profileId: 'prf_observed', anonymousId: 'observed-2' })]);
        }
        return true;
      },
    });
    expect(result.complete).toBe(false);
    expect(result.tables.find((table) => table.table === 'events')).toEqual({ table: 'events', deleted: 1, remaining: true });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, lateWs)).toEqual([
      { n: 1 },
    ]);
  }, 60_000);

  it('stops before the next batch when the caller lost its claim', async () => {
    const claimWs = newUuid();
    await store.insert([0, 1, 2, 3, 4].map((i) => event(i, { workspaceId: claimWs, profileId: 'prf_claim', anonymousId: `claim-${i}` })));
    const key = hmac('profile', 'prf_claim');
    await publish(store, claimWs, [key]);
    let checks = 0;
    const result = await store.purgeErasedSubjects(claimWs, [key], {
      batchSize: 1,
      maxBatches: 5,
      checkpoint: async () => {
        checks++;
        // The staged load and the first two deletes hold the claim; another replica takes it before
        // a third mutation.
        return checks <= 3;
      },
    });
    expect(checks).toBe(4);
    expect(result).toMatchObject({ deleted: 2, complete: false });
    expect(result.tables).toEqual([{ table: 'events', deleted: 2, remaining: true }]);
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, claimWs)).toEqual([
      { n: 3 },
    ]);
  }, 60_000);

  it('renews its claim before each staging batch and stops without a delete when it is lost', async () => {
    const stageWs = newUuid();
    await store.insert([event(0, { workspaceId: stageWs, profileId: 'prf_stage_claim', anonymousId: 'stage-claim-anon' })]);
    const key = hmac('profile', 'prf_stage_claim');
    await publish(store, stageWs, [key]);
    // The whole ledger is staged before the first delete, so loading it can outlast the lease. This
    // one needs more than one staged insert.
    const ledger = Array.from({ length: 2_500 }, (_, i) => hmac('anonymous_id', `stage-claim-${i}-${'s'.repeat(40)}`));
    const originalInsert = store.client.insert.bind(store.client);
    let stagedBatches = 0;
    store.client.insert = (async (args) => {
      if ((args as unknown as { table?: string }).table === 'erasure_purge_keys') stagedBatches += 1;
      return originalInsert(args);
    }) as typeof store.client.insert;
    let checks = 0;
    let result: Awaited<ReturnType<typeof store.purgeErasedSubjects>>;
    try {
      // The claim holds for the first batch and another replica takes it before the second.
      result = await store.purgeErasedSubjects(stageWs, [key, ...ledger], {
        checkpoint: async () => {
          checks += 1;
          return checks < 2;
        },
      });
    } finally {
      store.client.insert = originalInsert;
    }
    expect(checks).toBe(2);
    expect(stagedBatches).toBe(1);
    expect(result).toEqual({ deleted: 0, complete: false, tables: [] });
    // No delete ran, and the partial run's rows are dropped rather than left for the next sweep.
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, stageWs)).toEqual([
      { n: 1 },
    ]);
    expect(await rows<{ n: number }>('SELECT count() AS n FROM erasure_purge_keys WHERE workspace_id = {ws:UUID}', {}, stageWs)).toEqual([
      { n: 0 },
    ]);
  }, 120_000);

  it('does not confirm visibility after its caller aborts between chunks', async () => {
    const visibilityWs = newUuid();
    // Enough long keys for several 32 KiB chunks, so the abort lands between two requests.
    const keys = Array.from({ length: 1_200 }, (_, i) => hmac('anonymous_id', `visibility-${i}-${'v'.repeat(40)}`));
    await publish(store, visibilityWs, keys);
    const abort = new AbortController();
    const isolated = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory, signal: abort.signal });
    try {
      const realQuery = isolated.client.query.bind(isolated.client);
      let issued = 0;
      isolated.client.query = (async (args: Parameters<typeof realQuery>[0]) => {
        const result = await realQuery(args);
        issued += 1;
        // The restore loses its lock while this chunk's answer is in flight.
        abort.abort(new Error('the restore lock was lost'));
        return result;
      }) as typeof isolated.client.query;
      await expect(isolated.erasedSubjectsVisible(visibilityWs, keys)).rejects.toThrow(/restore lock was lost/);
      expect(issued).toBe(1);
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it('issues no chunk request when its caller aborts while the workspace settings resolve', async () => {
    const settingsWs = newUuid();
    const keys = [hmac('anonymous_id', 'settings-abort')];
    await publish(store, settingsWs, keys);
    const abort = new AbortController();
    const isolated = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory, signal: abort.signal });
    try {
      // `settingsFor` probes the server once (`SELECT 1`) before it can answer. The lock is lost as
      // that probe returns, so the abort lands between the settings resolve and the chunk request.
      const realCommand = isolated.client.command.bind(isolated.client);
      isolated.client.command = (async (args: Parameters<typeof realCommand>[0]) => {
        const result = await realCommand(args);
        if ((args as { query?: string }).query === 'SELECT 1') abort.abort(new Error('the restore lock was lost'));
        return result;
      }) as typeof isolated.client.command;
      const realQuery = isolated.client.query.bind(isolated.client);
      let chunks = 0;
      isolated.client.query = (async (args: Parameters<typeof realQuery>[0]) => {
        if (String((args as { query?: string }).query).includes('countDistinct')) chunks += 1;
        return realQuery(args);
      }) as typeof isolated.client.query;
      await expect(isolated.erasedSubjectsVisible(settingsWs, keys)).rejects.toThrow(/restore lock was lost/);
      expect(chunks).toBe(0);
    } finally {
      await isolated.close();
    }
  }, 60_000);
});

// #1146 part 2: with row policies off, the purge must still scope its count and delete subquery to
// the workspace being purged. Otherwise another workspace's rows with the same identity inflate
// `deleted` and can consume the bounded batch.
describe('physical purge is scoped by workspace without row policies (#1146)', () => {
  const NOPOLICY_DB = runScoped('am_test_purge_nopolicy');
  const wsA = newUuid();
  const wsB = newUuid();
  let plain: EventStore;

  const eventFor = (workspaceId: string, messageId: string): BusEvent => ({
    ...event(1),
    workspaceId,
    messageId,
    anonymousId: 'shared-anon',
    userId: 'shared-user',
    profileId: 'prf_shared',
  });

  beforeAll(async () => {
    await resetClickHouse(CH_URL, NOPOLICY_DB);
    await migrateClickHouse(CH_URL, NOPOLICY_DB, undefined, { rowPolicies: 'off' });
    plain = clickHouseStore({ url: CH_URL, database: NOPOLICY_DB, subjectKeys: factory });
    await plain.insert([eventFor(wsA, 'shared-a'), eventFor(wsB, 'shared-b')]);
  }, 60_000);

  afterAll(async () => {
    await plain?.close();
  });

  it('deletes and counts only the purged workspace’s rows', async () => {
    const key = hmac('profile', 'prf_shared');
    await publish(plain, wsA, [key]);
    const result = await plain.purgeErasedSubjects(wsA, [key], { batchSize: 100 });
    expect(result).toMatchObject({ complete: true, deleted: 1 });

    const countIn = async (workspaceId: string) => {
      const rs = await plain.client.query({
        query: 'SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}',
        query_params: { ws: workspaceId },
        format: 'JSONEachRow',
      });
      const [row] = await rs.json<{ n: number | string }>();
      return Number(row?.n ?? 0);
    };
    expect(await countIn(wsA)).toBe(0);
    expect(await countIn(wsB)).toBe(1);
  }, 60_000);
});
