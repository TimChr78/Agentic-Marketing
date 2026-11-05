import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// v0.7.5 measurement/export regressions:
//   #366 campaign uplift must not stop at a workspace-wide 100k conversion cap; the decisive late
//        conversion is asserted directly and through campaigns.holdoutResult.
//   #369 a re-entrant's conversion/unsubscribe is attributed to exactly one split entry/arm, with
//        deterministic ties and no effect from before-entry or out-of-window events.
//   #397 profiles.events/export/list page by (timestamp, id) so tied rows are neither skipped nor
//        repeated, including full Postgres microsecond precision and malformed-cursor rejection.

const PORT = testPort(3520);
const DB = 'test_v075_measurement';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let wsPages = '';
let keyPages = '';
let pagesApi: ReturnType<typeof t.api>;
let campaignApi: ReturnType<typeof t.api>;
let pageProfileIds = new Set<string>();
let pagesFirstProfile = '';

const stamp = Date.now();
const campaignApiCall = () => campaignApi;

const ingest = (sourceKey: string, batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${sourceKey}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const sources = async (api: ReturnType<typeof t.api>, name: string) => {
  const created = await api.call('sources.create', { name, kind: 'server' });
  return created.key;
};

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`measurement-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  wsPages = await t.workspaceWith([[owner, 'owner']], 'none');
  campaignApi = t.api(owner, ws);
  pagesApi = t.api(owner, wsPages);
  key = await sources(campaignApi, 'Campaign backend');
  keyPages = await sources(pagesApi, 'Pages backend');
}, 180_000);

afterAll(() => t?.close());

describe('campaign conversion measurement (#366)', () => {
  it('returns a conversion beyond the old 100k workspace cap and counts it for treatment', async () => {
    const api = campaignApiCall();
    const campaignId = (
      await api.call('artifacts.create', {
        type: 'campaign',
        name: 'No cap campaign',
        content: {
          description: 'Conversions past the old fixed row limit',
          goal: { kind: 'conversion', event: 'Campaign Purchase', attributionDays: 7 },
          controlGroup: { percent: 50, minSampleSize: 1 },
          members: [],
        } as never,
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: campaignId, note: 'v0.7.5 measurement test' });

    await ingest(key, [
      { type: 'identify', userId: 'cap-late', traits: { email: `cap-late-${stamp}@example.com` } },
      { type: 'track', event: 'Campaign Start', userId: 'cap-late', timestamp: '2026-11-05T09:00:00Z' },
    ]);
    const profileId = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: 'cap-late' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const assignedAt = new Date('2026-11-05T09:00:00Z');
    const bulkAt = '2026-11-05T09:00:01.000';
    const lateAt = new Date('2026-11-05T09:00:02Z');

    // One treatment assignment in the window. The old query counted the workspace's earliest
    // 100k goal events and only then filtered to this person in code, so the late conversion was
    // invisible whenever the workspace was busy.
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
       VALUES ($1, 'campaign', $2, $3, $4, 'treatment', $5)`,
      [ws, campaignId, holdoutHashVersion(50), profileId, assignedAt],
    );

    // 100k unrelated goal events, all earlier than the decisive conversion.
    const settings = await t.srv.events.settingsFor(ws);
    await t.srv.events.client.command({
      query: `INSERT INTO events
                (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                 anonymous_id, user_id, profile_id, properties, traits, context, consent)
              SELECT {ws:UUID}, concat('bulk-', toString(number)), 'src_bulk',
                     {at:DateTime64(3, 'UTC')}, {at:DateTime64(3, 'UTC')},
                     'track', 'Campaign Purchase',
                     concat('bulk-anon-', toString(number)), '', '',
                     CAST('{}' AS JSON), CAST('{}' AS JSON), CAST('{}' AS JSON), map()
              FROM numbers({n:UInt32})`,
      query_params: { ws, at: bulkAt, n: 100_000 },
      clickhouse_settings: settings as never,
    });
    await t.srv.events.client.command({
      query: `INSERT INTO events
                (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                 anonymous_id, user_id, profile_id, properties, traits, context, consent)
              SELECT {ws:UUID}, 'late-conversion', 'src_late',
                     {at:DateTime64(3, 'UTC')}, {at:DateTime64(3, 'UTC')},
                     'track', 'Campaign Purchase', '', {user:String}, {profile:String},
                     CAST('{}' AS JSON), CAST('{}' AS JSON), CAST('{}' AS JSON), map()`,
      query_params: { ws, at: lateAt.toISOString().replace('Z', ''), user: 'cap-late', profile: 'prf_merged_away' },
      clickhouse_settings: settings as never,
    });

    // The store itself returns every matching event: 100,000 early + 1 late.
    const all = await t.srv.events.conversionEvents(ws, {
      names: ['Campaign Purchase'],
      from: new Date('2026-11-05T09:00:00Z'),
      to: new Date('2026-11-12T09:00:00Z'),
    });
    expect(all).toHaveLength(100_001);
    expect(all.at(-1)?.userId).toBe('cap-late');

    // Historical CH profile ids remain on pre-merge events; current identifiers point at the survivor.
    const empty = await t.srv.events.conversionEvents(ws, {
      names: ['Campaign Purchase'],
      from: assignedAt,
      to: lateAt,
      profileIds: [],
      identifiers: { anonymousIds: [], userIds: [] },
    });
    expect(empty).toEqual([]);
    const result = await api.call('campaigns.holdoutResult', { campaignId });
    expect(result.treatment).toMatchObject({ entered: 1, converted: 1 });
    expect(result.control).toMatchObject({ entered: 0, converted: 0 });
  }, 180_000);

  it('ai.calibration sees a late outcome behind more than 100k scoped events', async () => {
    const api = campaignApiCall();
    await ingest(key, [
      { type: 'identify', userId: 'cal-other', traits: { email: `cal-other-${stamp}@example.com` } },
      { type: 'identify', userId: 'cal-late', traits: { email: `cal-late-${stamp}@example.com` } },
    ]);
    const profile = async (userId: string) =>
      (
        await eventually(
          () => api.call('profiles.find', { type: 'user_id', value: userId }),
          (r) => !!r.profileId,
        )
      ).profileId!;
    const other = await profile('cal-other');
    const late = await profile('cal-late');
    const scoredAt = new Date('2026-10-01T08:00:00Z');
    for (const profileId of [other, late])
      await t.srv.db.admin.query(
        `INSERT INTO profile_scores
           (workspace_id, profile_id, key, value, model, model_version, created_at, expires_at)
         VALUES ($1, $2, 'cap_calibration', 0.9, 'test', '1', $3, '2030-01-01T00:00:00Z')
         ON CONFLICT (workspace_id, profile_id, key) DO UPDATE SET created_at = excluded.created_at`,
        [ws, profileId, scoredAt],
      );

    const settings = await t.srv.events.settingsFor(ws);
    // 100k outcomes for the other scored profile, all earlier than the target's late outcome. The
    // old unscoped LIMIT 100_000 would spend the whole budget here and report the target negative.
    await t.srv.events.client.command({
      query: `INSERT INTO events
                (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                 anonymous_id, user_id, profile_id, properties, traits, context, consent)
              SELECT {ws:UUID}, concat('cal-bulk-', toString(number)), 'src_cal',
                     {at:DateTime64(3, 'UTC')}, {at:DateTime64(3, 'UTC')},
                     'track', 'Calibration Goal', '', 'cal-other', '',
                     CAST('{}' AS JSON), CAST('{}' AS JSON), CAST('{}' AS JSON), map()
              FROM numbers({n:UInt32})`,
      query_params: { ws, at: '2026-10-01 08:00:01.000', n: 100_000 },
      clickhouse_settings: settings as never,
    });
    await t.srv.events.client.command({
      query: `INSERT INTO events
                (workspace_id, event_id, source_id, received_at, timestamp, type, name,
                 anonymous_id, user_id, profile_id, properties, traits, context, consent)
              SELECT {ws:UUID}, 'cal-late', 'src_cal',
                     {at:DateTime64(3, 'UTC')}, {at:DateTime64(3, 'UTC')},
                     'track', 'Calibration Goal', '', 'cal-late', 'prf_merged_away',
                     CAST('{}' AS JSON), CAST('{}' AS JSON), CAST('{}' AS JSON), map()`,
      query_params: { ws, at: '2026-10-01 08:00:02.000' },
      clickhouse_settings: settings as never,
    });

    const result = await api.call('ai.calibration', { scoreKey: 'cap_calibration', event: 'Calibration Goal', withinDays: 14 });
    expect(result).toMatchObject({ predictions: 2, positives: 2, baseRate: 1 });
  }, 180_000);
});

it('sends large measurement scopes without exceeding the ClickHouse URI limit', async () => {
  const ids = Array.from({ length: 20_000 }, (_, i) => `prf_large_scope_${String(i).padStart(20, '0')}`);
  const anonymousIds = ids.map((id) => `anon_${id}`);
  const rows = await t.srv.events.conversionEvents(ws, {
    names: ['Campaign Purchase'],
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-11-06T00:00:00Z'),
    profileIds: ids,
    identifiers: { anonymousIds, userIds: [...ids.slice(0, -1), 'cap-late'] },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.userId).toBe('cap-late');
}, 120_000);

describe('journey split attribution (#369)', () => {
  it('attributes each outcome once, including re-entry, ties, before-entry and out-of-window events', async () => {
    const api = campaignApiCall();
    const journeyId = (
      await api.call('artifacts.create', {
        type: 'journey',
        name: 'Split attribution',
        content: {
          purpose: 'marketing_email',
          nodes: [
            {
              id: 'trigger',
              kind: 'trigger',
              label: 'Start',
              config: { event: 'Split Start', reentry: 'always' },
              next: [{ to: 'split' }],
            },
            { id: 'split', kind: 'split', label: 'A/B', config: { weights: [50, 50] }, next: [{ to: 'a' }, { to: 'b' }] },
            { id: 'a', kind: 'exit', label: 'A', config: {} },
            { id: 'b', kind: 'exit', label: 'B', config: {} },
          ],
        } as never,
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'v0.7.5 split test' });

    const base = Date.parse('2026-11-05T10:00:00Z');
    const at = (ms: number) => new Date(ms).toISOString();
    const step = (participantId: number, profileId: string, variant: number, ms: number, seq = 1) => ({
      workspaceId: ws,
      journeyId,
      version: 1,
      participantId,
      profileId,
      node: 'split',
      type: 'step' as const,
      seq,
      at: at(ms),
      detail: `variant ${variant}`,
    });
    const converted = (participantId: number, profileId: string, ms: number) => ({
      workspaceId: ws,
      journeyId,
      version: 1,
      participantId,
      profileId,
      node: 'done',
      type: 'converted' as const,
      seq: 9,
      at: at(ms),
      detail: 'Split Goal',
    });

    // P1 re-enters: arm 0 first, arm 1 later; P3 has two entries at the same millisecond; P4 loops
    // through the split twice under one participant; P7 enters but its conversion is out of range.
    // The last three entries cover #419: a second entry that bypassed the split (109/110), and a
    // participant that converts before its own later take (111/112).
    await t.srv.events.insertJourneyEvents([
      step(101, 'prf_reentry', 1, base),
      step(102, 'prf_reentry', 2, base + 2_000, 2),
      step(103, 'prf_before', 2, base),
      step(105, 'prf_tie', 1, base),
      step(106, 'prf_tie', 2, base),
      step(107, 'prf_loop', 1, base),
      step(107, 'prf_loop', 2, base + 1_000, 2),
      step(108, 'prf_outside', 1, base + 500),
      step(109, 'prf_bypass', 1, base),
      step(111, 'prf_before2', 1, base),
      step(112, 'prf_before2', 2, base + 3_000, 2),
    ]);
    await t.srv.events.insertJourneyEvents([
      converted(101, 'prf_reentry', base + 1_000),
      { ...converted(101, 'prf_reentry', base + 1_500), seq: 10 },
      converted(102, 'prf_reentry', base + 3_000),
      converted(103, 'prf_before', base - 1_000),
      // Participant 0 is not a real participant (journey ids start at 1) and no storage sentinel
      // defines it as absent. Its conversion must not borrow the profile's equal-time take (#419).
      converted(0, 'prf_tie', base),
      converted(107, 'prf_loop', base + 3_000),
      converted(108, 'prf_outside', base + 20_000),
      // Participant 110 never reached the split; participant 112 converts before its own take.
      converted(110, 'prf_bypass', base + 1_000),
      converted(112, 'prf_before2', base + 2_000),
    ]);
    await t.srv.events.insertMessageEvents([
      {
        workspaceId: ws,
        messageId: 'msg_split_1',
        eventId: 'msg_split_1',
        type: 'unsubscribed',
        at: at(base + 500),
        profileId: 'prf_reentry',
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: 'eml_split',
        templateVersion: 1,
        journeyId,
        variant: '',
        reason: '',
        url: '',
      },
      {
        workspaceId: ws,
        messageId: 'msg_split_2',
        eventId: 'msg_split_2',
        type: 'unsubscribed',
        at: at(base + 2_500),
        profileId: 'prf_reentry',
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: 'eml_split',
        templateVersion: 1,
        journeyId,
        variant: '',
        reason: '',
        url: '',
      },
      {
        workspaceId: ws,
        messageId: 'msg_split_3',
        eventId: 'msg_split_3',
        type: 'unsubscribed',
        at: at(base),
        profileId: 'prf_tie',
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: 'eml_split',
        templateVersion: 1,
        journeyId,
        variant: '',
        reason: '',
        url: '',
      },
    ]);

    const arms = await t.srv.events.journeySplitArms(ws, { journeyId, node: 'split' });
    expect(arms).toHaveLength(10);
    expect(arms.find((a) => a.participantId === 107)?.arm).toBe(0);
    expect(arms.find((a) => a.participantId === 106)?.arm).toBe(1);
    const later = await t.srv.events.journeySplitArms(ws, {
      journeyId,
      node: 'split',
      from: new Date(base + 500),
      to: new Date(base + 5_000),
    });
    // Filtering cannot turn participant 107's later loop into its first split take.
    expect(later.map((a) => a.participantId).sort()).toEqual([102, 108, 112]);

    const result = await api.call('journeys.splitResult', {
      journeyId,
      node: 'split',
      from: at(base),
      to: at(base + 5_000),
      minSampleSize: 1,
    });
    // Entrants: arm0 = 101/105/107/108/109/111 (6), arm1 = 102/103/106/112 (4). Conversions:
    // 101 once for its first entry, 107 once for its first take, 102 for its own take. 103 and 112
    // converted before their own take, 110 never took the split and 0 is not a participant, so none
    // may borrow an earlier profile entry (#419). 108's conversion is out of the report window.
    // Unsubscribes have no participant: prf_reentry at +500/+2500 go to 101/102 by time, and the
    // equal-time prf_tie unsubscribe goes to the higher participant id (106, arm 1).
    expect(result.arms).toMatchObject([
      { arm: 0, entered: 6, converted: 2, unsubscribed: 1 },
      { arm: 1, entered: 4, converted: 1, unsubscribed: 2 },
    ]);
    expect(result.arms.reduce((n, a) => n + a.converted, 0)).toBe(3);
  }, 120_000);
});

describe('profile pagination and export (#397)', () => {
  it('pages 501 tied events with a composite cursor and keeps maxEvents honest', async () => {
    const tiedAt = '2026-10-01T12:34:56.123Z';
    await ingest(
      keyPages,
      Array.from({ length: 25 }, (_, i) => ({
        type: 'identify',
        userId: `tie-person-${i}`,
        traits: { email: `tie-person-${i}-${stamp}@example.com` },
      })),
    );
    const found = await eventually(
      () =>
        t.srv.db.admin.query<{ value: string; profile_id: string }>(
          `SELECT i.value, i.profile_id FROM identifiers i
           WHERE i.workspace_id = $1 AND i.type = 'user_id' AND i.value LIKE 'tie-person-%'`,
          [wsPages],
        ),
      (r) => r.rows.length === 25,
      20_000,
    );
    const profileOf = new Map(found.rows.map((r) => [r.value, r.profile_id]));
    const firstProfile = profileOf.get('tie-person-0')!;
    pageProfileIds = new Set(profileOf.values());
    pagesFirstProfile = firstProfile;

    await ingest(
      keyPages,
      Array.from({ length: 501 }, (_, i) => ({
        type: 'track',
        event: 'Tie Event',
        userId: 'tie-person-0',
        timestamp: tiedAt,
        properties: { n: i },
      })),
    );
    await eventually(
      async () => {
        const settings = await t.srv.events.settingsFor(wsPages);
        const rs = await t.srv.events.client.query({
          query: `SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID} AND name = 'Tie Event'`,
          query_params: { ws: wsPages },
          format: 'JSONEachRow',
          clickhouse_settings: settings as never,
        });
        return Number((await rs.json<{ n: string }>())[0]!.n);
      },
      (n) => n === 501,
      20_000,
    );

    // Walk profiles.events across several pages. Before #397 the next page used `timestamp <`
    // alone, so the remaining 301 events at the boundary vanished.
    const eventIds: string[] = [];
    let cursor: { timestamp: string; eventId: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const r: { events: { eventId: string }[]; nextCursor: { timestamp: string; eventId: string } | null } = await pagesApi.call(
        'profiles.events',
        {
          profileId: firstProfile,
          limit: 200,
          ...(cursor ? { before: cursor.timestamp, beforeId: cursor.eventId } : {}),
        },
      );
      eventIds.push(...r.events.map((e) => e.eventId));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    // 501 tied track events plus the one identify event that created the profile.
    expect(eventIds).toHaveLength(502);
    expect(new Set(eventIds).size).toBe(502);

    const full = await pagesApi.call('profiles.export', { profileId: firstProfile, maxEvents: 1000 });
    const exported = full.events.filter((e) => e.name === 'Tie Event');
    expect(exported).toHaveLength(501);
    expect(new Set(exported.map((e) => e.eventId)).size).toBe(501);
    const capped = await pagesApi.call('profiles.export', { profileId: firstProfile, maxEvents: 250 });
    expect(capped.events).toHaveLength(250);
    expect(capped.eventsTruncated).toBe(true);
    expect(full.eventsTruncated).toBe(false);
    const exact = await pagesApi.call('profiles.export', { profileId: firstProfile, maxEvents: full.events.length });
    expect(exact.eventsTruncated).toBe(false);
    const none = await pagesApi.call('profiles.export', { profileId: firstProfile, maxEvents: 0 });
    expect(none.events).toEqual([]);
    expect(none.eventsTruncated).toBe(true);
  }, 120_000);

  it('pages profiles.list through many tied lastSeen values without skipping or repeating', async () => {
    const readAll = async () => {
      const ids: string[] = [];
      let cursor: { lastSeen: string; id: string } | null = null;
      for (let page = 0; page < 10; page++) {
        const r: { profiles: { id: string }[]; nextCursor: { lastSeen: string; id: string } | null } = await pagesApi.call(
          'profiles.list',
          {
            limit: 10,
            ...(cursor ? { before: cursor.lastSeen, beforeId: cursor.id } : {}),
          },
        );
        ids.push(...r.profiles.map((p) => p.id));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(25);
      expect(new Set(ids)).toEqual(pageProfileIds);
    };

    // Exact ties: every profile shares one lastSeen, so only the id tie-breaker can move the page.
    await t.srv.db.admin.query(
      `WITH ranked AS (
         SELECT p.id FROM profiles p
         JOIN identifiers i ON i.profile_id = p.id AND i.type = 'user_id' AND i.value LIKE 'tie-person-%'
         WHERE p.workspace_id = $1
       ) UPDATE profiles p
       SET last_seen = '2026-10-01 12:34:56.123000+00'::timestamptz
       FROM ranked WHERE p.workspace_id = $1 AND p.id = ranked.id`,
      [wsPages],
    );
    await readAll();

    // Now one microsecond apart inside one millisecond. A Date-rounded cursor would either repeat
    // or skip the rest of the block.
    await t.srv.db.admin.query(
      `WITH ranked AS (
         SELECT p.id, row_number() OVER (ORDER BY p.id) AS n
         FROM profiles p
         JOIN identifiers i ON i.profile_id = p.id AND i.type = 'user_id' AND i.value LIKE 'tie-person-%'
         WHERE p.workspace_id = $1
       ) UPDATE profiles p
       SET last_seen = '2026-10-01 12:34:56.123000+00'::timestamptz + ranked.n * interval '1 microsecond'
       FROM ranked WHERE p.workspace_id = $1 AND p.id = ranked.id`,
      [wsPages],
    );
    await readAll();
  });

  it('rejects malformed cursors before a database cast', async () => {
    const before = await rejects(pagesApi.call('profiles.list', { before: '2026-02-30T12:00:00Z' }));
    expect(before.status).toBe(400);
    expect(before.code).toBe('invalid_input');
    const id = await rejects(pagesApi.call('profiles.list', { before: '2026-11-05T12:34:56.123456Z', beforeId: 'not-a-profile' }));
    expect(id.status).toBe(400);
    const events = await rejects(pagesApi.call('profiles.events', { profileId: pagesFirstProfile, before: 'not-a-time' }));
    expect(events.status).toBe(400);
    expect(events.code).toBe('invalid_input');
  });
});
