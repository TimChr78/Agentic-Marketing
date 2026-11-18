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
    expect(key).not.toContain('prf_legacy_erased');
    const result = await store.purgeErasedSubjects(legacyWs, [key], { batchSize: 10 });
    expect(result).toMatchObject({ complete: true, deleted: 1 });
    expect(await rows<{ name: string }>('SELECT name FROM events FINAL', {}, legacyWs)).toEqual([{ name: 'Live' }]);
  }, 60_000);

  it('stops at the batch bound and reports that a later round must continue', async () => {
    const boundedWs = newUuid();
    await store.insert(
      [0, 1, 2, 3, 4].map((i) => event(i, { workspaceId: boundedWs, profileId: 'prf_bounded', anonymousId: `bounded-${i}` })),
    );
    const key = hmac('profile', 'prf_bounded');
    const first = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ deleted: 2, complete: false });
    expect(first.tables.find((table) => table.table === 'events')).toMatchObject({ deleted: 2, remaining: true });
    const second = await store.purgeErasedSubjects(boundedWs, [key], { batchSize: 10, maxBatches: 2 });
    expect(second).toMatchObject({ deleted: 3, complete: true });
    expect(await rows<{ n: number }>('SELECT count() AS n FROM events FINAL', {}, boundedWs)).toEqual([{ n: 0 }]);
  }, 60_000);
});
