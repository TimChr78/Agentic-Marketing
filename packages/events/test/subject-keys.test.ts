import { createHmac } from 'node:crypto';
import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import {
  type BusEvent,
  clickHouseStore,
  clickIdsOfEvent,
  type EventStore,
  type JourneyEvent,
  type MessageEvent,
  migrateClickHouse,
  resetClickHouse,
  type SubjectKeyHasher,
  type SubjectKeyKind,
  subjectKeyFailureCount,
} from '../src';

// #1037 part 1: person-linked ClickHouse rows keep HMAC_exclusion of every identifier, the
// erased-subjects table is generation-versioned, and the historical backfill writes side-table
// rows keyed by identity — it never rewrites a person row and never lets the key reach ClickHouse.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_subject_keys');
const ws = newUuid();
const KEY = Buffer.alloc(32, 9);

const hmac = (kind: SubjectKeyKind, value: string) => createHmac('sha256', KEY).update(`${kind}:${value}`).digest('hex');
const hasher: SubjectKeyHasher = {
  version: 'dk_exclusion_test',
  async hash(kind, value) {
    return hmac(kind, value);
  },
  dispose() {},
};
const factory = async () => hasher;

let store: EventStore;

const event = (i: number, over: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_subject_keys',
  messageId: `subject-${i}`,
  type: 'track',
  name: 'Subject Event',
  anonymousId: `anon-${i}`,
  userId: `user-${i}`,
  profileId: `prf-${i}`,
  timestamp: new Date(Date.UTC(2026, 8, 10, 12, 0, i)).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 8, 10, 12, 0, i)).toISOString(),
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const messageEvent = (i: number): MessageEvent => ({
  workspaceId: ws,
  messageId: `msg-${i}`,
  eventId: `evt-${i}`,
  type: 'delivered',
  at: new Date(Date.UTC(2026, 8, 10, 12, 0, i)).toISOString(),
  profileId: `prf-msg-${i}`,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: 'eml_test',
  templateVersion: 1,
  journeyId: 'bct_test',
  reason: '',
  url: '',
});

const journeyEvent = (i: number): JourneyEvent => ({
  workspaceId: ws,
  journeyId: 'jrn_test',
  version: 1,
  participantId: i,
  profileId: `prf-jrn-${i}`,
  node: 'start',
  type: 'entered',
  seq: i,
  at: new Date(Date.UTC(2026, 8, 10, 12, 0, i)).toISOString(),
  detail: '',
});

/** Reads rows through the same row-policy setting the store uses. */
async function rows<T>(query: string, workspace: string = ws, params: Record<string, unknown> = {}): Promise<T[]> {
  const settings = await store.settingsFor(workspace);
  const rs = await store.client.query({
    query,
    query_params: { ws: workspace, ...params },
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  return rs.json<T>();
}

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
}, 60_000);

afterAll(async () => {
  await store?.close();
});

describe('subject keys on stored rows (#1037 part 1)', () => {
  it('fills every new event’s subject columns with keyed hashes and coverage full', async () => {
    const timestamp = new Date(Date.UTC(2026, 8, 11, 12, 0, 0)).toISOString();
    const fresh = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
    try {
      await fresh.insert([
        event(1, {
          profileId: 'prf-1',
          previousId: 'anon-previous-1',
          timestamp,
          piiTraits: { email: 'Person@Example.test', phone: '+1 (555) 010-0300' },
          context: { clickIds: { gclid: 'gclid-abc123', fbc: 'fb.1.1700000000000.abcdef' } },
        }),
        event(2, { anonymousId: 'anon-2', userId: '' }),
      ]);
    } finally {
      await fresh.close();
    }
    const stored = await rows<Record<string, string | number>>(
      `SELECT event_id, subject_profile, subject_anonymous, subject_user, subject_previous, subject_email,
              subject_phone, subject_gclid, subject_fbc, subject_key_version, subject_coverage
         FROM events FINAL WHERE workspace_id = {ws:UUID} ORDER BY event_id`,
    );
    const first = stored.find((r) => r.event_id === 'subject-1')!;
    expect(first).toMatchObject({
      subject_profile: hmac('profile', 'prf-1'),
      subject_anonymous: hmac('anonymous_id', 'anon-1'),
      subject_user: hmac('user_id', 'user-1'),
      subject_previous: hmac('alias_previous_id', 'anon-previous-1'),
      subject_email: hmac('email', 'Person@Example.test'),
      subject_phone: hmac('phone', '+1 (555) 010-0300'),
      subject_gclid: hmac('gclid', 'gclid-abc123'),
      subject_fbc: hmac('fbc', 'fb.1.1700000000000.abcdef'),
      subject_key_version: 'dk_exclusion_test',
      subject_coverage: 'full',
    });
    expect(Object.keys(clickIdsOfEvent({ clickIds: { gclid: 'abcd' } }, 0))).toEqual(['gclid']);
    // No raw identifier in the subject columns (the legacy id columns are unchanged).
    const serialised = JSON.stringify(stored);
    for (const raw of ['Person@Example.test', 'person@example.test', '5550100300', 'user-1', 'anon-previous-1', 'gclid-abc123'])
      expect(serialised).not.toContain(raw);
  });

  it('fills the subject profile hash on new message and journey events', async () => {
    await store.insertMessageEvents([messageEvent(1)]);
    await store.insertJourneyEvents([journeyEvent(1)]);
    const [message] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_key_version, subject_coverage FROM message_events FINAL
        WHERE workspace_id = {ws:UUID} AND message_id = {id:String}`,
      ws,
      { id: 'msg-1' },
    );
    const [journey] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_key_version, subject_coverage FROM journey_events FINAL
        WHERE workspace_id = {ws:UUID} AND journey_id = {id:String}`,
      ws,
      { id: 'jrn_test' },
    );
    expect(message).toMatchObject({
      subject_profile: hmac('profile', 'prf-msg-1'),
      subject_key_version: 'dk_exclusion_test',
      subject_coverage: 'full',
    });
    expect(journey).toMatchObject({
      subject_profile: hmac('profile', 'prf-jrn-1'),
      subject_key_version: 'dk_exclusion_test',
      subject_coverage: 'full',
    });
  });

  it('keeps the newest exclusion generation and never partitions it by month', async () => {
    const published = (generation: number, recordedAt: string) => [
      {
        workspaceId: ws,
        kind: 'profile' as const,
        key: 'hash-profile-pub',
        keyVersion: 'dk_exclusion_test',
        erasureId: 'era_pub',
        generation,
        recordedAt,
      },
    ];
    await store.publishErasedSubjects(published(2, '2026-11-01T00:00:00.000Z'));
    await store.publishErasedSubjects(published(1, '2026-01-15T00:00:00.000Z'));
    const kept = await rows<{ generation: number | string }>(
      `SELECT generation FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID} AND kind = 'profile' AND key = 'hash-profile-pub'`,
    );
    expect(kept).toEqual([{ generation: 2 }]);
  });

  it('backfills into a side table without rewriting rows, and revalidates later legacy rows', async () => {
    const legacyWs = newUuid();
    const legacy = (name: string, day: number, over: Record<string, unknown> = {}) => ({
      workspace_id: legacyWs,
      event_id: `legacy-${name}`,
      source_id: 'src_legacy',
      received_at: `2026-07-${String(day).padStart(2, '0')} 12:00:00`,
      timestamp: `2026-07-${String(day).padStart(2, '0')} 12:00:00`,
      type: 'track',
      name,
      anonymous_id: `legacy-anon-${name}`,
      user_id: `legacy-user-${name}`,
      profile_id: `prf-legacy-${name}`,
      properties: {},
      traits: {},
      context: { clickIds: { gclid: `gclid-${name}-1234` } },
      consent: {},
      ...over,
    });
    await store.client.insert({
      table: 'events',
      values: [legacy('Bravo', 10), legacy('Charlie', 20), legacy('Delta', 25)],
      format: 'JSONEachRow',
    });
    await store.client.insert({
      table: 'message_events',
      values: [
        {
          workspace_id: legacyWs,
          message_id: 'legacy-msg',
          event_id: 'legacy-evt',
          type: 'delivered',
          at: '2026-07-10 12:00:00',
          profile_id: 'prf-legacy-msg',
          channel: 'email',
          purpose: 'marketing_email',
          provider: 'test',
          template_id: 'eml_test',
          template_version: 1,
          journey_id: 'bct_test',
          reason: '',
          url: '',
        },
      ],
      format: 'JSONEachRow',
    });
    await store.client.insert({
      table: 'journey_events',
      values: [
        {
          workspace_id: legacyWs,
          journey_id: 'jrn_legacy',
          version: 1,
          participant_id: 1,
          profile_id: 'prf-legacy-jrn',
          node: 'start',
          type: 'entered',
          seq: 1,
          at: '2026-07-10 12:00:00',
          detail: '',
        },
      ],
      format: 'JSONEachRow',
    });

    const first = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(first.done).toBe(false);

    // A complete concurrent writer row for an identity the backfill has not reached yet: its own
    // subject columns must never be touched by the backfill.
    const complete = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
    try {
      await complete.insert([
        event(50, {
          workspaceId: legacyWs,
          messageId: 'legacy-Delta',
          name: 'Delta',
          anonymousId: 'legacy-anon-Delta',
          userId: 'legacy-user-Delta',
          profileId: 'prf-legacy-Delta',
          piiTraits: { email: 'delta@example.test' },
          context: {},
          timestamp: '2026-07-25T12:00:00.000Z',
          receivedAt: '2026-07-25T12:00:00.000Z',
        }),
      ]);
    } finally {
      await complete.close();
    }

    // A legacy row that sorts before the cursor lands later. A low-frequency revalidation pass
    // (the store resets the cursor when a pass completes) still finds it.
    const restarted = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
    try {
      for (let i = 0; i < 8; i++) {
        const step = await restarted.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
        if (step.done) break;
      }
    } finally {
      await restarted.close();
    }
    const late = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(late.done).toBe(true);
    await store.client.insert({ table: 'events', values: [legacy('Alpha', 1)], format: 'JSONEachRow' });
    let again = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 5 });
    for (let i = 0; i < 4 && !again.done; i++) again = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 5 });
    expect(again.done).toBe(true);
    expect(await store.subjectKeyCoverage([legacyWs])).toMatchObject({ pending: 0 });

    const settings = await store.settingsFor(legacyWs);
    const sideRs = await store.client.query({
      query: `SELECT key1, key2, key3, key4, subject_profile, subject_anonymous, subject_user, subject_gclid,
                     subject_key_version, subject_coverage
              FROM subject_key_backfill FINAL WHERE workspace_id = {ws:UUID} AND table_name = 'events' ORDER BY key1`,
      query_params: { ws: legacyWs },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const side = await sideRs.json<Record<string, string | number>>();
    expect(side.map((r) => r.key4)).toEqual(['legacy-Alpha', 'legacy-Bravo', 'legacy-Charlie']);
    for (const row of side) {
      const name = String(row.key1);
      expect(row).toMatchObject({
        key2: `legacy-anon-${name}`,
        subject_profile: hmac('profile', `prf-legacy-${name}`),
        subject_anonymous: hmac('anonymous_id', `legacy-anon-${name}`),
        subject_user: hmac('user_id', `legacy-user-${name}`),
        subject_key_version: 'dk_exclusion_test',
        subject_coverage: 'ids_only',
      });
    }
    // Delta also has a writer row: the backfill leaves it alone (coverage full) and its own e-mail
    // hash is still there, so a stale copy can never supersede the complete redelivery.
    const delta = await rows<Record<string, string | number>>(
      `SELECT subject_email, subject_coverage FROM events FINAL WHERE workspace_id = {ws:UUID} AND event_id = 'legacy-Delta'`,
      legacyWs,
    );
    expect(delta[0]).toMatchObject({ subject_email: hmac('email', 'delta@example.test'), subject_coverage: 'full' });
    // Legacy rows themselves were never rewritten.
    const legacyRow = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_coverage FROM events FINAL WHERE workspace_id = {ws:UUID} AND event_id = 'legacy-Bravo'`,
      legacyWs,
    );
    expect(legacyRow[0]).toMatchObject({ subject_profile: '', subject_coverage: 'none' });

    const [message] = await rows<Record<string, string | number>>(
      `SELECT key1, subject_profile, subject_coverage FROM subject_key_backfill FINAL
        WHERE workspace_id = {ws:UUID} AND table_name = 'message_events'`,
      legacyWs,
    );
    const [journey] = await rows<Record<string, string | number>>(
      `SELECT key1, subject_profile, subject_coverage FROM subject_key_backfill FINAL
        WHERE workspace_id = {ws:UUID} AND table_name = 'journey_events'`,
      legacyWs,
    );
    expect(message).toMatchObject({ key1: 'legacy-msg', subject_profile: hmac('profile', 'prf-legacy-msg'), subject_coverage: 'ids_only' });
    expect(journey).toMatchObject({ key1: 'jrn_legacy', subject_profile: hmac('profile', 'prf-legacy-jrn'), subject_coverage: 'ids_only' });
  }, 120_000);

  it('keys side-table rows by the full replacing key, not a client-supplied event id', async () => {
    const legacyWs = newUuid();
    const row = (name: string, anonymousId: string) => ({
      workspace_id: legacyWs,
      event_id: 'shared-client-id',
      source_id: 'src_shared',
      received_at: '2026-08-01 12:00:00',
      timestamp: '2026-08-01 12:00:00',
      type: 'track',
      name,
      anonymous_id: anonymousId,
      user_id: '',
      profile_id: '',
      properties: {},
      traits: {},
      context: {},
      consent: {},
    });
    await store.client.insert({
      table: 'events',
      values: [row('Alice Page', 'alice-anon'), row('Bob Page', 'bob-anon')],
      format: 'JSONEachRow',
    });
    let step = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    for (let i = 0; i < 4 && !step.done; i++) step = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 10 });
    expect(step.done).toBe(true);
    expect((await store.subjectKeyCoverage([legacyWs])).pending).toBe(0);
    const settings = await store.settingsFor(legacyWs);
    const rs = await store.client.query({
      query: `SELECT key1, key2, key4, subject_anonymous FROM subject_key_backfill FINAL
              WHERE workspace_id = {ws:UUID} AND table_name = 'events' ORDER BY key1`,
      query_params: { ws: legacyWs },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const side = await rs.json<{ key1: string; key2: string; key4: string; subject_anonymous: string }>();
    expect(side).toEqual([
      { key1: 'Alice Page', key2: 'alice-anon', key4: 'shared-client-id', subject_anonymous: hmac('anonymous_id', 'alice-anon') },
      { key1: 'Bob Page', key2: 'bob-anon', key4: 'shared-client-id', subject_anonymous: hmac('anonymous_id', 'bob-anon') },
    ]);
  }, 60_000);

  it('resets the cursor when the forward scan ends with rows still uncovered', async () => {
    const legacyWs = newUuid();
    const legacy = (name: string) => ({
      workspace_id: legacyWs,
      event_id: `stall-${name}`,
      source_id: 'src_stall',
      received_at: '2026-08-10 12:00:00',
      timestamp: '2026-08-10 12:00:00',
      type: 'track',
      name,
      anonymous_id: `stall-anon-${name}`,
      user_id: '',
      profile_id: '',
      properties: {},
      traits: {},
      context: {},
      consent: {},
    });
    await store.client.insert({ table: 'events', values: [legacy('Zulu')], format: 'JSONEachRow' });
    const first = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(first.tables.find((t) => t.table === 'events')?.advanced).toBe(true);

    // A legacy row that sorts before the cursor arrives. The next forward scan is empty but the
    // count is positive; the cursor must reset so a later pass can reach it.
    await store.client.insert({ table: 'events', values: [legacy('Aardvark')], format: 'JSONEachRow' });
    const empty = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(empty.tables.find((t) => t.table === 'events')).toMatchObject({ advanced: false, remaining: true });
    const found = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(found.tables.find((t) => t.table === 'events')?.advanced).toBe(true);
    const settings = await store.settingsFor(legacyWs);
    const rs = await store.client.query({
      query: `SELECT key1 FROM subject_key_backfill FINAL WHERE workspace_id = {ws:UUID} AND table_name = 'events' ORDER BY key1`,
      query_params: { ws: legacyWs },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    expect((await rs.json<{ key1: string }>()).map((row) => row.key1)).toEqual(['Aardvark', 'Zulu']);
  }, 60_000);

  it('continues a pass past a historical row whose context cannot be read, to the next workspace', async () => {
    const poisonedWs = newUuid();
    const nextWs = newUuid();
    const legacy = (workspaceId: string, name: string, context: Record<string, unknown>) => ({
      workspace_id: workspaceId,
      event_id: `legacy-${name}`,
      source_id: 'src_legacy_context',
      received_at: '2026-08-05 12:00:00',
      timestamp: '2026-08-05 12:00:00',
      type: 'track',
      name,
      anonymous_id: `legacy-anon-${name}`,
      user_id: '',
      profile_id: `prf-legacy-${name}`,
      properties: {},
      traits: {},
      context,
      consent: {},
    });
    await store.client.insert({
      table: 'events',
      values: [
        legacy(poisonedWs, 'Poisoned', { page: { url: 5 } }),
        legacy(nextWs, 'Next Workspace', { page: { url: 'https://shop.test/landing?gclid=abc123' } }),
      ],
      format: 'JSONEachRow',
    });

    let step = await store.backfillSubjectKeys({ workspaceIds: [poisonedWs, nextWs], batchSize: 10 });
    for (let i = 0; i < 3 && !step.done; i++) step = await store.backfillSubjectKeys({ workspaceIds: [poisonedWs, nextWs], batchSize: 10 });
    expect(step.done).toBe(true);
    expect(await store.subjectKeyCoverage([poisonedWs, nextWs])).toMatchObject({ pending: 0 });

    // The unreadable context costs that row its click ids only; the ids it stores are still keyed,
    // and the workspace listed after it is reached.
    const sideRow = async (workspaceId: string) => {
      const rs = await store.client.query({
        query: `SELECT key1, subject_profile, subject_anonymous, subject_gclid
                FROM subject_key_backfill FINAL WHERE workspace_id = {ws:UUID} AND table_name = 'events'`,
        query_params: { ws: workspaceId },
        format: 'JSONEachRow',
        clickhouse_settings: await store.settingsFor(workspaceId),
      });
      return await rs.json<Record<string, string>>();
    };
    expect(await sideRow(nextWs)).toEqual([
      {
        key1: 'Next Workspace',
        subject_profile: hmac('profile', 'prf-legacy-Next Workspace'),
        subject_anonymous: hmac('anonymous_id', 'legacy-anon-Next Workspace'),
        subject_gclid: hmac('gclid', 'abc123'),
      },
    ]);
    expect(await sideRow(poisonedWs)).toEqual([
      {
        key1: 'Poisoned',
        subject_profile: hmac('profile', 'prf-legacy-Poisoned'),
        subject_anonymous: hmac('anonymous_id', 'legacy-anon-Poisoned'),
        subject_gclid: '',
      },
    ]);
  }, 60_000);

  it('fails the write when the exclusion key cannot be resolved, and counts the failure', async () => {
    const before = subjectKeyFailureCount();
    const broken = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: async () => {
        throw new Error('exclusion key unavailable');
      },
    });
    try {
      await expect(broken.insert([event(9)])).rejects.toThrow('exclusion key unavailable');
      expect(subjectKeyFailureCount()).toBe(before + 1);
    } finally {
      await broken.close();
    }
    const stored = await rows<{ event_id: string }>(`SELECT event_id FROM events FINAL WHERE event_id = 'subject-9'`);
    expect(stored).toEqual([]);
  });
});
