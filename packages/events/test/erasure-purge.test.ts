import { createHmac } from 'node:crypto';
import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Publishes a workspace's exclusion keys, as the erasure cleanup does before a sweep. The purge
 * matches the published set in `erased_subjects`, so a key must be published to be swept.
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
        // The second checkpoint is the side-table batch, after the base table reached zero. A late
        // legacy row arrives now: it has no subject keys of its own and depends on `side-b`.
        if (checks === 2)
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

  it('sweeps a workspace whose published ledger is larger than one query parameter', async () => {
    const ledgerWs = newUuid();
    const total = 3_200;
    // A ledger this size is ordinary for a long-lived person. Bound as one `Array(String)`, it is
    // over ClickHouse's 128 KiB field limit and every count, batch select and delete failed, so the
    // physical purge could never make progress.
    const anonymousIds = Array.from({ length: total }, (_, i) => `ledger-${String(i).padStart(4, '0')}-${'k'.repeat(40)}`);
    const keys = anonymousIds.map((id) => hmac('anonymous_id', id));
    await publish(store, ledgerWs, keys);
    await store.insert([event(0, { workspaceId: ledgerWs, anonymousId: anonymousIds[0], userId: '', profileId: '' })]);

    const result = await store.purgeErasedSubjects(ledgerWs, keys, { batchSize: 100 });
    expect(result).toMatchObject({ complete: true, deleted: 1 });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, ledgerWs)).toEqual([
      { n: 0 },
    ]);
    // The purge never deletes the exclusions it matched.
    expect(
      await rows<{ n: number }>('SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}', {}, ledgerWs),
    ).toEqual([{ n: total }]);
  }, 120_000);

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
        // The first two batches hold the claim; another replica takes it before a third mutation.
        return checks <= 2;
      },
    });
    expect(checks).toBe(3);
    expect(result).toMatchObject({ deleted: 2, complete: false });
    expect(result.tables).toEqual([{ table: 'events', deleted: 2, remaining: true }]);
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}', {}, claimWs)).toEqual([
      { n: 3 },
    ]);
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
