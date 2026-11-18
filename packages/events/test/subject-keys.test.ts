import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import type { SubjectKeyHashes } from '../src';
import {
  type BusEvent,
  clickHouseStore,
  type EventStore,
  type JourneyEvent,
  type MessageEvent,
  migrateClickHouse,
  resetClickHouse,
} from '../src';

// #1037 part 1: person-linked ClickHouse rows carry the ledger's subject keys, the erased-subjects
// table takes idempotent publishes, and the historical backfill fills old rows in partitions. No
// read path uses any of it yet.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_subject_keys');
const ws = newUuid();

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
  store = clickHouseStore({ url: CH_URL, database: CH_DB });
}, 60_000);

afterAll(async () => {
  await store?.close();
});

describe('subject keys on stored rows (#1037 part 1)', () => {
  it('fills every new event’s subject columns, including keyed e-mail and phone hashes', async () => {
    const hashes: SubjectKeyHashes = { emailHash: 'email-hash-1', phoneHash: 'phone-hash-1', version: 'dk_subject_1' };
    const withKeys = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: async (events) => events.map((_event, i) => (i === 0 ? hashes : null)),
    });
    try {
      await withKeys.insert([
        event(1, { piiTraits: { email: 'person@example.test', phone: '+15550100300' } }),
        event(2, { anonymousId: 'anon-2', userId: '' }),
      ]);
    } finally {
      await withKeys.close();
    }
    const stored = await rows<{
      event_id: string;
      subject_profile_id: string;
      subject_anonymous_id: string;
      subject_user_id: string;
      subject_email_hash: string;
      subject_phone_hash: string;
      subject_key_version: string;
      subject_keys_set: number | string;
    }>(
      `SELECT event_id, subject_profile_id, subject_anonymous_id, subject_user_id, subject_email_hash,
              subject_phone_hash, subject_key_version, subject_keys_set
         FROM events FINAL WHERE workspace_id = {ws:UUID} ORDER BY event_id`,
    );
    expect(stored.find((r) => r.event_id === 'subject-1')).toMatchObject({
      subject_profile_id: 'prf-1',
      subject_anonymous_id: 'anon-1',
      subject_user_id: 'user-1',
      subject_email_hash: 'email-hash-1',
      subject_phone_hash: 'phone-hash-1',
      subject_key_version: 'dk_subject_1',
      subject_keys_set: 1,
    });
    // No e-mail/phone trait on the second event: the ids are still there, the hashes stay empty.
    expect(stored.find((r) => r.event_id === 'subject-2')).toMatchObject({
      subject_profile_id: 'prf-2',
      subject_anonymous_id: 'anon-2',
      subject_user_id: '',
      subject_email_hash: '',
      subject_phone_hash: '',
      subject_key_version: '',
      subject_keys_set: 1,
    });
    // Nothing stored the plaintext traits.
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('person@example.test');
    expect(serialised).not.toContain('15550100300');
  });

  it('fills the subject profile id on new message and journey events', async () => {
    await store.insertMessageEvents([messageEvent(1)]);
    await store.insertJourneyEvents([journeyEvent(1)]);
    const [message] = await rows<{ subject_profile_id: string; subject_keys_set: number | string }>(
      `SELECT subject_profile_id, subject_keys_set FROM message_events FINAL WHERE workspace_id = {ws:UUID} AND message_id = {id:String}`,
      ws,
      { id: 'msg-1' },
    );
    const [journey] = await rows<{ subject_profile_id: string; subject_keys_set: number | string }>(
      `SELECT subject_profile_id, subject_keys_set FROM journey_events FINAL WHERE workspace_id = {ws:UUID} AND journey_id = {id:String}`,
      ws,
      { id: 'jrn_test' },
    );
    expect(message).toMatchObject({ subject_profile_id: 'prf-msg-1', subject_keys_set: 1 });
    expect(journey).toMatchObject({ subject_profile_id: 'prf-jrn-1', subject_keys_set: 1 });
  });

  it('publishes erasure exclusions idempotently', async () => {
    const published = [
      {
        workspaceId: ws,
        kind: 'profile' as const,
        key: 'prf-pub',
        keyVersion: '',
        erasureId: 'era_pub',
        generation: 1,
        recordedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        workspaceId: ws,
        kind: 'email' as const,
        key: 'hash-pub',
        keyVersion: 'dk_pub',
        erasureId: 'era_pub',
        generation: 1,
        recordedAt: '2026-11-01T00:00:00.000Z',
      },
    ];
    await store.publishErasedSubjects(published);
    await store.publishErasedSubjects(published);
    const publishedRows = await rows<{ kind: string; key: string; key_version: string }>(
      `SELECT kind, key, key_version FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID} ORDER BY kind, key`,
    );
    expect(publishedRows).toEqual([
      { kind: 'email', key: 'hash-pub', key_version: 'dk_pub' },
      { kind: 'profile', key: 'prf-pub', key_version: '' },
    ]);
  });

  it('backfills historical rows by partition, resumably and idempotently', async () => {
    const backfillWs = newUuid();
    // Legacy rows: written before the subject columns existed, one per month so the backfill has
    // three partitions to walk, plus one message and one journey row.
    const legacy = (i: number, month: number, over: Partial<Record<string, unknown>> = {}) => ({
      workspace_id: backfillWs,
      event_id: `legacy-${month}-${i}`,
      source_id: 'src_legacy',
      received_at: `2026-0${month}-10 12:00:0${i}`,
      timestamp: `2026-0${month}-10 12:00:0${i}`,
      type: 'track',
      name: 'Legacy Event',
      anonymous_id: `legacy-anon-${month}-${i}`,
      user_id: `legacy-user-${month}-${i}`,
      profile_id: `prf-legacy-${month}-${i}`,
      properties: {},
      traits: {},
      context: {},
      consent: {},
      ...over,
    });
    await store.client.insert({
      table: 'events',
      values: [legacy(1, 7), legacy(2, 7), legacy(3, 8), legacy(4, 9)],
      format: 'JSONEachRow',
    });
    await store.client.insert({
      table: 'message_events',
      values: [
        {
          workspace_id: backfillWs,
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
          workspace_id: backfillWs,
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

    // One partition per table per call: July only for events, counts still 0 elsewhere.
    const first = await store.backfillSubjectKeys({ partitionsPerCall: 1 });
    expect(first.done).toBe(false);
    const afterOne = await rawSubjects(backfillWs);
    expect(afterOne).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_id: 'legacy-7-1', subject_profile_id: 'prf-legacy-7-1', subject_keys_set: 1 }),
        expect.objectContaining({ event_id: 'legacy-9-4', subject_profile_id: '', subject_keys_set: 0 }),
      ]),
    );
    expect(afterOne.find((r) => r.event_id === 'legacy-9-4')?.subject_profile_id).toBe('');

    // A new store instance (a restart) resumes from the cursor and finishes every partition.
    const restarted = clickHouseStore({ url: CH_URL, database: CH_DB });
    try {
      for (let i = 0; i < 10; i++) {
        const step = await restarted.backfillSubjectKeys({ partitionsPerCall: 1 });
        if (step.done) break;
        expect(step.tables.every((t) => t.pending === false)).toBe(true);
      }
    } finally {
      await restarted.close();
    }
    const finished = await rawSubjects(backfillWs);
    for (const row of finished) {
      expect(row.subject_keys_set).toBe(1);
    }
    expect(finished.find((r) => r.event_id === 'legacy-8-3')).toMatchObject({
      subject_profile_id: 'prf-legacy-8-3',
      subject_anonymous_id: 'legacy-anon-8-3',
      subject_user_id: 'legacy-user-8-3',
    });
    const messages = await rows<{ subject_profile_id: string; subject_keys_set: number | string }>(
      `SELECT subject_profile_id, subject_keys_set FROM message_events FINAL WHERE workspace_id = {ws:UUID} AND message_id = 'legacy-msg'`,
      backfillWs,
    );
    const journeys = await rows<{ subject_profile_id: string; subject_keys_set: number | string }>(
      `SELECT subject_profile_id, subject_keys_set FROM journey_events FINAL WHERE workspace_id = {ws:UUID} AND journey_id = 'jrn_legacy'`,
      backfillWs,
    );
    expect(messages[0]).toMatchObject({ subject_profile_id: 'prf-legacy-msg', subject_keys_set: 1 });
    expect(journeys[0]).toMatchObject({ subject_profile_id: 'prf-legacy-jrn', subject_keys_set: 1 });

    // Idempotent: a completed backfill reports done and rewrites nothing.
    const again = await store.backfillSubjectKeys({ partitionsPerCall: 1 });
    expect(again.done).toBe(true);
    expect(again.tables.every((t) => !t.advanced && !t.pending)).toBe(true);
  }, 120_000);
});

/** Raw subject columns of every backfilled event row, for the given workspace. */
async function rawSubjects(backfillWs: string): Promise<
  {
    event_id: string;
    subject_profile_id: string;
    subject_anonymous_id: string;
    subject_user_id: string;
    subject_keys_set: number | string;
  }[]
> {
  const settings = await store.settingsFor(backfillWs);
  const rs = await store.client.query({
    query: `SELECT event_id, subject_profile_id, subject_anonymous_id, subject_user_id, subject_keys_set
            FROM events FINAL WHERE workspace_id = {ws:UUID} ORDER BY event_id`,
    query_params: { ws: backfillWs },
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  return rs.json();
}
