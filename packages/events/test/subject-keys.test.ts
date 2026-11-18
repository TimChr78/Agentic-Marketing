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
} from '../src';

// #1037 part 1: person-linked ClickHouse rows keep HMAC_exclusion of every identifier, the
// erased-subjects table is generation-versioned, and the historical backfill reads rows, hashes
// their identifiers in the app and writes them back — it never lets the key reach ClickHouse.

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
  it('fills every new event’s subject columns with keyed hashes, including traits and click ids', async () => {
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
              subject_phone, subject_gclid, subject_fbc, subject_key_version, subject_keys_set
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
      subject_keys_set: 1,
    });
    // The click-id list is the same one the ads package uses.
    expect(Object.keys(clickIdsOfEvent({ clickIds: { gclid: 'abcd' } }, 0))).toEqual(['gclid']);
    // No raw identifier in the subject columns (the legacy id columns are unchanged).
    const serialised = JSON.stringify(
      stored.map((r) => ({ ...r, subject_email: r.subject_email, subject_user: r.subject_user, subject_phone: r.subject_phone })),
    );
    for (const raw of ['Person@Example.test', 'person@example.test', '5550100300', 'user-1', 'anon-previous-1', 'gclid-abc123'])
      expect(serialised).not.toContain(raw);
  });

  it('fills the subject profile hash on new message and journey events', async () => {
    await store.insertMessageEvents([messageEvent(1)]);
    await store.insertJourneyEvents([journeyEvent(1)]);
    const [message] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_key_version, subject_keys_set FROM message_events FINAL
        WHERE workspace_id = {ws:UUID} AND message_id = {id:String}`,
      ws,
      { id: 'msg-1' },
    );
    const [journey] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_key_version, subject_keys_set FROM journey_events FINAL
        WHERE workspace_id = {ws:UUID} AND journey_id = {id:String}`,
      ws,
      { id: 'jrn_test' },
    );
    expect(message).toMatchObject({
      subject_profile: hmac('profile', 'prf-msg-1'),
      subject_key_version: 'dk_exclusion_test',
      subject_keys_set: 1,
    });
    expect(journey).toMatchObject({
      subject_profile: hmac('profile', 'prf-jrn-1'),
      subject_key_version: 'dk_exclusion_test',
      subject_keys_set: 1,
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
    // The older generation, published later and in another month, must not win or create a second row.
    expect(kept).toEqual([{ generation: 2 }]);
  });

  it('backfills historical rows in the app, revisiting a delayed row behind the cursor', async () => {
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

    // One row per table and workspace per call: the first call advances without finishing.
    const first = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(first.done).toBe(false);
    expect(first.tables.filter((t) => t.workspaceId === legacyWs).every((t) => t.advanced || t.done)).toBe(true);

    // A legacy row that sorts before the cursor lands after it passed. The FINAL count catches it
    // and the dirty pass revisits it.
    await store.client.insert({ table: 'events', values: [legacy('Alpha', 1)], format: 'JSONEachRow' });

    // A fresh store (a restart) resumes from the persisted cursor and finishes the job.
    const restarted = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: factory });
    try {
      for (let i = 0; i < 20; i++) {
        const step = await restarted.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
        if (step.done) break;
      }
    } finally {
      await restarted.close();
    }

    const settings = await store.settingsFor(legacyWs);
    const rs = await store.client.query({
      query: `SELECT event_id, subject_profile, subject_anonymous, subject_user, subject_gclid, subject_key_version, subject_keys_set
              FROM events FINAL WHERE workspace_id = {ws:UUID} ORDER BY event_id`,
      query_params: { ws: legacyWs },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const backfilled = await rs.json<Record<string, string | number>>();
    expect(backfilled.map((r) => r.event_id)).toEqual(['legacy-Alpha', 'legacy-Bravo', 'legacy-Charlie', 'legacy-Delta']);
    for (const row of backfilled) {
      const name = String(row.event_id).replace('legacy-', '');
      expect(row).toMatchObject({
        subject_profile: hmac('profile', `prf-legacy-${name}`),
        subject_anonymous: hmac('anonymous_id', `legacy-anon-${name}`),
        subject_user: hmac('user_id', `legacy-user-${name}`),
        subject_gclid: hmac('gclid', `gclid-${name}-1234`),
        subject_key_version: 'dk_exclusion_test',
        subject_keys_set: 1,
      });
    }
    const [message] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_keys_set FROM message_events FINAL WHERE workspace_id = {ws:UUID} AND message_id = 'legacy-msg'`,
      legacyWs,
    );
    const [journey] = await rows<Record<string, string | number>>(
      `SELECT subject_profile, subject_keys_set FROM journey_events FINAL WHERE workspace_id = {ws:UUID} AND journey_id = 'jrn_legacy'`,
      legacyWs,
    );
    expect(message).toMatchObject({ subject_profile: hmac('profile', 'prf-legacy-msg'), subject_keys_set: 1 });
    expect(journey).toMatchObject({ subject_profile: hmac('profile', 'prf-legacy-jrn'), subject_keys_set: 1 });

    // Idempotent: a completed backfill reports done and writes nothing.
    const again = await store.backfillSubjectKeys({ workspaceIds: [legacyWs], batchSize: 1 });
    expect(again.done).toBe(true);
    expect(again.tables.every((t) => !t.advanced && t.done)).toBe(true);
  }, 120_000);

  it('fails the write when the exclusion key cannot be resolved', async () => {
    const broken = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: async () => {
        throw new Error('exclusion key unavailable');
      },
    });
    try {
      await expect(broken.insert([event(9)])).rejects.toThrow('exclusion key unavailable');
    } finally {
      await broken.close();
    }
    // Nothing was stored for the failed row.
    const stored = await rows<{ event_id: string }>(`SELECT event_id FROM events FINAL WHERE event_id = 'subject-9'`);
    expect(stored).toEqual([]);
  });
});
