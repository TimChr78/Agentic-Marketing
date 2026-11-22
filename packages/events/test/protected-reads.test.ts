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
  PERSON_TABLES,
  PROTECTED_VIEWS,
  resetClickHouse,
  type SubjectKeyHasher,
  type SubjectKeyKind,
} from '../src';

// #1037 part 2: after an erasure's ledger is published, every protected reader excludes the erased
// person's rows — including rows written after publication — without touching the base tables the
// writers and the sweep use. The tests drive the production EventStore methods against a real
// ClickHouse, so they read the same views the application does.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_protected_reads');
const ws = newUuid();
const other = newUuid();
const KEY = Buffer.alloc(32, 11);
const VERSION = 'dk_exclusion_test';

const hmac = (kind: SubjectKeyKind, value: string) => createHmac('sha256', KEY).update(`${kind}:${value}`).digest('hex');
const hasher: SubjectKeyHasher = {
  version: VERSION,
  async hash(kind, value) {
    return hmac(kind, value);
  },
  dispose() {},
};
let store: EventStore;

const AT = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));

const event = (over: Partial<BusEvent> & { workspaceId?: string }): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_protected',
  messageId: newUuid(),
  type: 'track',
  name: 'Purchase',
  anonymousId: '',
  userId: '',
  profileId: '',
  timestamp: AT.toISOString(),
  receivedAt: AT.toISOString(),
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const messageEvent = (over: Partial<MessageEvent>): MessageEvent => ({
  workspaceId: ws,
  messageId: 'bct_protected',
  eventId: newUuid(),
  type: 'sent',
  at: AT.toISOString(),
  profileId: '',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: 'eml_protected',
  templateVersion: 1,
  journeyId: 'bct_protected',
  reason: '',
  url: '',
  ...over,
});

const journeyEvent = (over: Partial<JourneyEvent>): JourneyEvent => ({
  workspaceId: ws,
  journeyId: 'jrn_protected',
  version: 1,
  participantId: 1,
  profileId: '',
  node: 'start',
  type: 'entered',
  seq: 1,
  at: AT.toISOString(),
  detail: '',
  ...over,
});

/** Rows read through the same row-policy setting the store uses (no protected view). */
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

const erasedRow = (key: string, workspace = ws, kind: SubjectKeyKind = 'profile', generation = 1) => ({
  workspaceId: workspace,
  kind,
  key,
  keyVersion: VERSION,
  erasureId: 'era_protected',
  generation,
  recordedAt: AT.toISOString(),
});

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: async () => hasher });

  // Two people of one workspace, and a third in another workspace whose identifier hash is the
  // same as workspace B's would be if it were keyed there (the test hasher is workspace-agnostic,
  // so an unscoped exclusion would leak across tenants).
  await store.insert([
    event({
      name: 'Purchase',
      anonymousId: 'anon-A',
      userId: 'user-A',
      profileId: 'prf-A',
      previousId: 'anon-A-prev',
      piiTraits: { email: 'a@example.test', phone: '+1 555 0100' },
      context: { clickIds: { gclid: 'gclid-A' } },
    }),
    event({ name: 'Purchase', anonymousId: 'anon-B', userId: 'user-B', profileId: 'prf-B' }),
    event({ workspaceId: other, name: 'Purchase', anonymousId: 'anon-other', userId: 'user-other', profileId: 'prf-other' }),
    // A merged-away family member of person A: the ledger names every profile of the family.
    event({ name: 'Family Event', anonymousId: 'anon-A2', profileId: 'prf-A-merged' }),
    // An experiment exposure and its goal, one per person.
    event({
      name: 'Experience Viewed',
      anonymousId: 'anon-A',
      profileId: 'prf-A',
      properties: { experience_id: 'exp_1', version: 1, variant_id: 'control' },
    }),
    event({ name: 'Configured', anonymousId: 'anon-A', profileId: 'prf-A' }),
    event({
      name: 'Experience Viewed',
      anonymousId: 'anon-B',
      profileId: 'prf-B',
      properties: { experience_id: 'exp_1', version: 1, variant_id: 'control' },
    }),
    event({ name: 'Configured', anonymousId: 'anon-B', profileId: 'prf-B' }),
  ]);
  await store.insertMessageEvents([
    messageEvent({ messageId: 'bct_A', profileId: 'prf-A', type: 'sent' }),
    messageEvent({ messageId: 'bct_B', profileId: 'prf-B', type: 'sent' }),
    messageEvent({ messageId: 'bct_A', profileId: 'prf-A', type: 'unsubscribed', journeyId: 'jrn_protected' }),
    messageEvent({ messageId: 'bct_B', profileId: 'prf-B', type: 'unsubscribed', journeyId: 'jrn_protected' }),
  ]);
  await store.insertJourneyEvents([
    journeyEvent({ participantId: 1, profileId: 'prf-A', type: 'entered' }),
    journeyEvent({ participantId: 1, profileId: 'prf-A', type: 'converted', node: 'goal', seq: 2 }),
    journeyEvent({ participantId: 1, profileId: 'prf-A', type: 'step', node: 'split', seq: 3, detail: 'variant 1' }),
    journeyEvent({ participantId: 2, profileId: 'prf-B', type: 'entered' }),
    journeyEvent({ participantId: 2, profileId: 'prf-B', type: 'converted', node: 'goal', seq: 2 }),
    journeyEvent({ participantId: 2, profileId: 'prf-B', type: 'step', node: 'split', seq: 3, detail: 'variant 2' }),
  ]);

  // A historical row with no subject columns, covered only by the backfill side table (part 1):
  // the protected view must coalesce it and exclude it.
  await store.client.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        workspace_id: ws,
        event_id: 'legacy-side-only',
        source_id: 'src_legacy',
        received_at: '2026-07-10 12:00:00',
        timestamp: '2026-07-10 12:00:00',
        type: 'track',
        name: 'Side Only',
        anonymous_id: 'anon-A',
        user_id: '',
        profile_id: '',
        properties: {},
        traits: {},
        context: {},
        consent: {},
      },
      {
        workspace_id: ws,
        event_id: 'legacy-uncovered',
        source_id: 'src_legacy',
        received_at: '2026-07-11 12:00:00',
        timestamp: '2026-07-11 12:00:00',
        type: 'track',
        name: 'Uncovered Legacy',
        anonymous_id: 'anon-nobody',
        user_id: '',
        profile_id: '',
        properties: {},
        traits: {},
        context: {},
        consent: {},
      },
    ],
  });
  await store.client.insert({
    table: 'subject_key_backfill',
    format: 'JSONEachRow',
    values: [
      {
        workspace_id: ws,
        table_name: 'events',
        key1: 'Side Only',
        key2: 'anon-A',
        key3: '2026-07-10 12:00:00.000',
        key4: 'legacy-side-only',
        subject_anonymous: hmac('anonymous_id', 'anon-A'),
        subject_key_version: VERSION,
        subject_coverage: 'ids_only',
        version: 1,
      },
    ],
  });

  // The committed erasure ledger for person A: every identifier kind, the merged-away family
  // member, the alias previous id, the click id and the address hashes.
  await store.publishErasedSubjects([
    erasedRow(hmac('profile', 'prf-A'), ws, 'profile'),
    erasedRow(hmac('profile', 'prf-A-merged'), ws, 'profile'),
    erasedRow(hmac('anonymous_id', 'anon-A'), ws, 'anonymous_id'),
    erasedRow(hmac('user_id', 'user-A'), ws, 'user_id'),
    erasedRow(hmac('alias_previous_id', 'anon-A-prev'), ws, 'alias_previous_id'),
    erasedRow(hmac('email', 'a@example.test'), ws, 'email'),
    erasedRow(hmac('phone', '+1 555 0100'), ws, 'phone'),
    erasedRow(hmac('gclid', 'gclid-A'), ws, 'gclid'),
    // Another tenant's exclusion may carry the same key value; it must not hide workspace B's row.
    erasedRow(hmac('anonymous_id', 'anon-B'), other, 'anonymous_id'),
  ]);

  // Rows written after publication: the sweep is not what makes them invisible.
  await store.insert([
    event({
      name: 'Late Purchase',
      anonymousId: 'anon-A-late',
      profileId: 'prf-A',
      piiTraits: { email: 'a@example.test' },
      timestamp: new Date(Date.UTC(2026, 9, 2, 12, 0, 0)).toISOString(),
    }),
  ]);
  await store.insertMessageEvents([
    messageEvent({ messageId: 'bct_late', profileId: 'prf-A', type: 'sent', at: '2026-10-02T12:00:00.000Z' }),
  ]);
  await store.insertJourneyEvents([
    journeyEvent({ participantId: 9, profileId: 'prf-A', type: 'entered', at: '2026-10-02T12:00:00.000Z' }),
  ]);
}, 120_000);

afterAll(async () => {
  await store?.close();
});

describe('protected reads exclude erased subjects (#1037 part 2)', () => {
  it('returns no raw events of an erased person, by anonymous id or user id', async () => {
    expect(await store.eventsOf(ws, { anonymousIds: ['anon-A'], userIds: ['user-A'] })).toEqual([]);
    expect(await store.eventsOfAnonymousIds(ws, ['anon-A'], 10)).toEqual([]);
    // The unrelated person is still there, in this workspace and the other one.
    expect((await store.eventsOf(ws, { anonymousIds: ['anon-B'], userIds: ['user-B'] })).map((e) => e.name)).toEqual([
      'Purchase',
      'Experience Viewed',
      'Configured',
    ]);
    expect((await store.eventsOf(other, { anonymousIds: ['anon-other'], userIds: ['user-other'] })).map((e) => e.name)).toEqual([
      'Purchase',
    ]);
  });

  it('excludes them from segment counts, including a row covered only by the backfill side table', async () => {
    expect(await store.countEvents(ws, { name: 'Purchase' })).toEqual([{ anonymousId: 'anon-B', userId: 'user-B', count: 1 }]);
    expect(await store.countEvents(ws, { name: 'Side Only' })).toEqual([]);
    // No subject coverage and no side entry: the row is unverified, so a workspace with erasures
    // fails closed and leaves it out of the read until the backfill covers it (#1195).
    expect(await store.countEvents(ws, { name: 'Uncovered Legacy' })).toEqual([]);
    const batched: { anonymousId: string }[] = [];
    for await (const batch of store.countEventsBatches(ws, { name: 'Purchase' })) batched.push(...batch);
    expect(batched).toEqual([{ anonymousId: 'anon-B', userId: 'user-B', count: 1 }]);
    expect(await store.countEvents(ws, { name: 'Family Event' })).toEqual([]);
  });

  it('excludes them from message-event counts, both event and engagement conditions (#441)', async () => {
    expect(await store.countMessageEvents(ws, { type: 'sent' })).toEqual([{ profileId: 'prf-B', count: 1 }]);
    expect(await store.countMessageEvents(ws, { type: 'unsubscribed', sentBy: 'jrn_protected' })).toEqual([
      { profileId: 'prf-B', count: 1 },
    ]);
    const batched: { profileId: string }[] = [];
    for await (const batch of store.countMessageEventsBatches(ws, { type: 'sent' })) batched.push(...batch);
    expect(batched).toEqual([{ profileId: 'prf-B', count: 1 }]);
  });

  it('excludes them from message stats and both halves of a pending-outbox union', async () => {
    const since = new Date(0);
    expect(await store.messageStats(ws, { since })).toEqual({ sent: 1, unsubscribed: 1 });
    const pending: MessageEvent[] = [
      messageEvent({ messageId: 'bct_pending_A', profileId: 'prf-A', type: 'sent' }),
      messageEvent({ messageId: 'bct_pending_B', profileId: 'prf-B', type: 'sent' }),
    ];
    // The published half is excluded by the view, the queued half by the same keyed hash in the app.
    expect(await store.messageStats(ws, { since, pendingEvents: pending })).toEqual({ sent: 2, unsubscribed: 1 });
    expect(await store.withoutErasedSubjects(ws, pending)).toEqual([pending[1]]);
  });

  it('excludes them from journeys: node counts, split arms and holdout outcomes', async () => {
    // The query has no ORDER BY; compare as a set.
    const counts = await store.journeyCounts(ws, 'jrn_protected');
    expect(counts.sort((a, b) => `${a.node}:${a.type}`.localeCompare(`${b.node}:${b.type}`))).toEqual([
      { node: 'goal', type: 'converted', count: 1 },
      { node: 'split', type: 'step', count: 1 },
      { node: 'start', type: 'entered', count: 1 },
    ]);
    expect(await store.journeySplitArms(ws, { journeyId: 'jrn_protected', node: 'split' })).toEqual([
      { participantId: 2, profileId: 'prf-B', arm: 1, at: AT.getTime() },
    ]);
    const outcomes = await store.journeyHoldoutOutcomes(ws, { journeyId: 'jrn_protected' });
    expect(outcomes.converted).toEqual(['prf-B']);
    expect(outcomes.unsubscribed).toEqual(['prf-B']);
    expect(outcomes.convertedAt.map((row) => row.profileId)).toEqual(['prf-B']);
    expect(outcomes.unsubscribedAt.map((row) => row.profileId)).toEqual(['prf-B']);
    expect(await store.unsubscribedProfiles(ws, { journeyIds: ['jrn_protected'] })).toEqual(['prf-B']);
  });

  it('excludes them from conversion reads, message reads and experiment counts', async () => {
    const conversions = await store.conversionEvents(ws, { names: ['Purchase'], from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)) });
    expect(conversions.map((row) => row.anonymousId)).toEqual(['anon-B']);
    const messages = await store.messageEventsOf(ws, {});
    expect(messages.map((row) => row.profileId)).toEqual(['prf-B', 'prf-B']);
    // An experiment's exposed and converted visitors: the erased person's exposure and goal are
    // both excluded, so the single remaining variant is the unrelated person.
    expect(await store.experimentCounts(ws, { experienceId: 'exp_1', version: 1, goal: 'Configured' })).toEqual({
      variants: [{ variant: 'control', exposed: 1, converted: 1 }],
      unversioned: 0,
    });
  });

  it('excludes a row written after publication (late write), without depending on the sweep', async () => {
    expect(await store.countEvents(ws, { name: 'Late Purchase' })).toEqual([]);
    const from = new Date(Date.UTC(2026, 9, 1));
    const to = new Date(Date.UTC(2026, 9, 3));
    expect(await store.conversionEvents(ws, { names: ['Late Purchase'], from, to })).toEqual([]);
    const stats = await store.messageStats(ws, { since: from, until: to, messageIds: ['bct_late'] });
    expect(stats).toEqual({});
    expect((await store.journeyCounts(ws, 'jrn_protected')).find((row) => row.count === 2)).toBeUndefined();
  });

  it('keeps the replacing-table semantics of the view: a newer physical copy is the logical row', async () => {
    const dupWs = newUuid();
    const base = event({ workspaceId: dupWs, name: 'Dup', anonymousId: 'dup-anon', profileId: 'prf-dup' });
    // Two physical copies of one replacing key: the older one lacks the subject columns entirely.
    await store.client.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          workspace_id: dupWs,
          event_id: 'dup-1',
          source_id: 'src',
          received_at: '2026-10-03 12:00:00',
          timestamp: base.timestamp.replace('T', ' ').replace('Z', ''),
          type: 'track',
          name: 'Dup',
          anonymous_id: 'dup-anon',
          user_id: '',
          profile_id: 'prf-dup',
          properties: {},
          traits: {},
          context: {},
          consent: {},
          subject_coverage: 'none',
        },
      ],
    });
    await store.client.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          workspace_id: dupWs,
          event_id: 'dup-1',
          source_id: 'src',
          received_at: '2026-10-03 12:00:00',
          timestamp: base.timestamp.replace('T', ' ').replace('Z', ''),
          type: 'track',
          name: 'Dup',
          anonymous_id: 'dup-anon',
          user_id: '',
          profile_id: 'prf-dup',
          properties: {},
          traits: {},
          context: {},
          consent: {},
          subject_profile: hmac('profile', 'prf-dup'),
          subject_coverage: 'full',
        },
      ],
    });
    await store.publishErasedSubjects([erasedRow(hmac('profile', 'prf-dup'), dupWs)]);
    expect(await store.countEvents(dupWs, { name: 'Dup' })).toEqual([]);
  });

  it('keeps the protected view column-for-column compatible with its table', async () => {
    for (const table of PERSON_TABLES) {
      const [tableColumns, viewColumns] = await Promise.all([
        rows<{ name: string; type: string }>(
          `SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {t:String} ORDER BY position`,
          ws,
          { t: table },
        ),
        rows<{ name: string; type: string }>(
          // A parameterized view has no stored column list; DESCRIBE of an invocation does.
          `DESCRIBE (SELECT * FROM ${PROTECTED_VIEWS[table]}(ws='${ws}'))`,
        ),
      ]);
      expect(viewColumns.map((column) => `${column.name}:${column.type}`)).toEqual(
        tableColumns.map((column) => `${column.name}:${column.type}`),
      );
    }
  }, 30_000);

  it('plans one workspace-keyed exclusion set, fed by the base rows', async () => {
    const settings = await store.settingsFor(ws);
    const rs = await store.client.query({
      // A shape the application actually sends: one workspace, one event name, a time window.
      query: `EXPLAIN SELECT count() FROM events_protected(ws={ws:UUID}) FINAL
              WHERE workspace_id = {ws:UUID} AND name = {name:String}
                AND timestamp >= {from:DateTime64(3, 'UTC')}`,
      query_params: { ws, name: 'Purchase', from: '2026-10-01 00:00:00' },
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const plan = (await rs.json<Record<string, string>>()).map((row) => Object.values(row).join('')).join('\n');
    // The ledger is read once, as a set, keyed by this workspace through the table's ordering
    // prefix; no per-row array and no per-kind joins.
    expect(plan).toMatch(/Capture\[Set\]|CreatingSets/);
    expect(plan).toContain(`workspace_id = '${ws}'`);
    expect(plan).toContain('FINAL: 1');
    expect(plan).not.toContain('groupUniqArray');
    expect(plan).not.toContain('LEFT ANTI JOIN');
    // The side table is read for one table and workspace, and joined on the full identity. On a
    // populated install the plan also builds runtime filters from the base rows; the seeded
    // benchmark pins that, because a one-row side table is too small for the planner to bother.
    expect(plan).toContain("table_name = 'events'");
    expect(plan).toContain('CAST(name AS String) = key1');
    expect(plan).toContain('toString(timestamp) = key3');
    // The base table is deduped before the exclusion runs: FINAL is applied to the table read.
    expect(plan).toMatch(/ReadFromMergeTree \([^)]*\.events\)[\s\S]*?FINAL: 1/);
  }, 30_000);
});
