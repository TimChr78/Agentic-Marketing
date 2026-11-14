import type { BusEvent, MessageEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.14.5 (#629, #630, #590): campaign attribution windows, revenue rows for non-converting
// campaigns, and one identity resolution for the headline and the holdout card.

const PORT = testPort(3497);
const DB = 'test_v0145_campaign_attribution';
const TZ = 'Europe/Copenhagen';
const FROM = '2026-04-25T00:00:00.000Z';
const TO = '2026-06-25T00:00:00.000Z';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let campaignA = '';
let campaignB = '';
let campaignC = '';
let campaignD = '';
let campaignM = '';
let campaignR = '';
let template = '';
let segment = '';

const stamp = Date.now();
const api = (workspaceId = wsA) => t.api(owner, workspaceId);

let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;

const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

function messageEvents(workspaceId: string, memberId: string, at: string, people: string[], delivered: number): MessageEvent[] {
  const out: MessageEvent[] = [];
  const add = (type: MessageEvent['type'], i: number) =>
    out.push({
      workspaceId,
      messageId: `msg_${memberId}_${i}`,
      eventId: `${memberId}:${type}:${i}`,
      type,
      at,
      profileId: people[i]!,
      channel: 'email',
      purpose: 'marketing_email',
      provider: 'log',
      templateId: '',
      templateVersion: 1,
      journeyId: memberId,
      variant: '',
      reason: '',
      url: '',
    });
  for (let i = 0; i < people.length; i++) add('sent', i);
  for (let i = 0; i < delivered; i++) add('delivered', i);
  return out;
}

interface ConvertOptions {
  workspaceId: string;
  name: string;
  at: string;
  profileId?: string;
  anonymousId?: string;
  userId?: string;
  properties?: Record<string, unknown>;
}
const conversion = (o: ConvertOptions): BusEvent => ({
  workspaceId: o.workspaceId,
  sourceId: 'test',
  messageId: `conv_${o.profileId ?? o.anonymousId ?? o.userId}_${o.at}`,
  type: 'track',
  name: o.name,
  anonymousId: o.anonymousId ?? '',
  userId: o.userId ?? '',
  profileId: o.profileId,
  timestamp: o.at,
  receivedAt: o.at,
  properties: o.properties ?? {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const columnIndex = (result: { columns: { name: string }[] }, name: string) => result.columns.findIndex((c) => c.name === name);
const cell = (result: { columns: { name: string }[]; rows: (string | number | null)[][] }, row: number, name: string) =>
  result.rows[row]![columnIndex(result, name)];

async function createCampaign(
  workspaceId: string,
  name: string,
  members: string[],
  goalInput: { kind?: 'conversion' | 'revenue'; event?: string; days?: number; controlGroup?: { percent: number; minSampleSize: number } },
) {
  const created = await api(workspaceId).call('artifacts.create', {
    type: 'campaign',
    name,
    content: {
      startsAt: '2026-04-30T00:00:00.000Z',
      goal: {
        kind: goalInput.kind ?? 'conversion',
        event: goalInput.event ?? 'Order Completed',
        attributionDays: goalInput.days ?? 7,
      },
      ...(goalInput.controlGroup ? { controlGroup: goalInput.controlGroup } : {}),
      members: members.map((artifactId) => ({ artifactId, role: 'primary' })),
    },
  });
  return created.artifactId;
}

const ingest = (key: string, batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const identifiersWithPrefix = async (workspaceId: string, prefix: string) =>
  (
    await t.srv.db.admin.query<{ value: string; profile_id: string }>(
      `SELECT i.value, i.profile_id FROM identifiers i
       WHERE i.workspace_id = $1 AND i.type = 'user_id' AND i.value LIKE $2 ORDER BY i.value`,
      [workspaceId, `${prefix}%`],
    )
  ).rows;

async function preparePeople(key: string, workspaceId: string, prefix: string, count: number) {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  await ingest(
    key,
    ids.map((userId) => ({ type: 'identify', userId, traits: { email: `${userId}-${stamp}@example.com` } })),
  );
  const rows = await eventually(
    () => identifiersWithPrefix(workspaceId, prefix),
    (r) => r.length === count,
    20_000,
  );
  return rows.map((r) => ({ userId: r.value, profileId: r.profile_id }));
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-campaign-attribution-${stamp}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']], 'none');
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('workspace.update', { timeZone: TZ });

  // wsA publishes a conversion map so revenue has a value and a currency to read; wsB never does,
  // which is the "self-hosted install without Meta/Google" state #632 reports.
  const connection = await api().call('connections.create', {
    connector: 'meta_ads',
    name: 'Meta attribution',
    settings: { pixelId: '1234567890' },
    secrets: { accessToken: 'test-access-token-1234567890' },
  });
  const map = await api().call('artifacts.create', {
    type: 'conversion_map',
    name: 'Conversions',
    content: {
      rules: [
        {
          event: 'Order Completed',
          value: 'total',
          currencyProperty: 'currency',
          meta: { connection: connection.id, eventName: 'Purchase' },
        },
      ],
    },
  });
  await api().call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'attribution test' });

  const tpl = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'Attribution issue',
    content: { purpose: 'marketing_email', subject: 'The issue', mjml },
  });
  template = tpl.artifactId;
  const seg = await api().call('artifacts.create', {
    type: 'segment',
    name: 'Attribution subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  segment = seg.artifactId;
  await api().call('artifacts.requestPublishBundle', { artifactIds: [template, segment], note: 'attribution prerequisites' });

  const broadcast = async (name: string) => {
    const b = await api().call('artifacts.create', { type: 'broadcast', name, content: { template, segment } });
    return b.artifactId;
  };
  const broadcastA = await broadcast('A broadcast');
  const broadcastB = await broadcast('B broadcast');
  const broadcastC = await broadcast('C broadcast');
  const broadcastD = await broadcast('D broadcast');
  const broadcastM = await broadcast('M broadcast');
  const journeyA = await api().call('artifacts.create', {
    type: 'journey',
    name: 'A follow-up journey',
    content: {
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'A Start', reentry: 'once' } },
        { id: 'email', kind: 'email', label: 'Mail', config: { template }, next: [{ to: 'done' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as never,
  });
  const journeyB = await api().call('artifacts.create', {
    type: 'journey',
    name: 'B follow-up journey',
    content: {
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'B Start', reentry: 'once' } },
        { id: 'email', kind: 'email', label: 'Mail', config: { template }, next: [{ to: 'done' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as never,
  });
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [broadcastA, broadcastB, broadcastC, broadcastD, broadcastM, journeyA.artifactId, journeyB.artifactId],
    note: 'attribution members',
  });

  // Two campaigns with two sending members each, and different windows. Whatever order the
  // published campaigns come back in, a member-aligned index shifts a later campaign's window or
  // runs out of range (#629).
  campaignA = await createCampaign(wsA, 'A campaign', [broadcastA, journeyA.artifactId], { days: 7 });
  campaignB = await createCampaign(wsA, 'B campaign', [broadcastB, journeyB.artifactId], { days: 1 });
  campaignC = await createCampaign(wsA, 'C campaign', [broadcastC], { days: 30 });
  campaignD = await createCampaign(wsA, 'D campaign', [broadcastD], { days: 7 });
  campaignM = await createCampaign(wsA, 'M campaign', [broadcastM], {
    days: 7,
    controlGroup: { percent: 50, minSampleSize: 1 },
  });
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [campaignA, campaignB, campaignC, campaignD, campaignM],
    note: 'attribution campaigns',
  });

  const pA = Array.from({ length: 6 }, person);
  const pB = Array.from({ length: 6 }, person);
  const pC = Array.from({ length: 6 }, person);
  const pD = Array.from({ length: 6 }, person);

  // M's people are real profiles: the holdout reads assignments from Postgres and the campaign
  // summary reads their sends from ClickHouse.
  const sourceKey = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  const mPeople = await preparePeople(sourceKey, wsA, 'holdout-m-', 20);
  const mProfileIds = mPeople.map((p) => p.profileId);
  const sendAt = '2026-05-10T10:00:00.000Z';

  await t.srv.events.insertMessageEvents([
    ...messageEvents(wsA, broadcastA, '2026-05-01T10:00:00.000Z', pA, 6),
    ...messageEvents(wsA, journeyA.artifactId, '2026-05-01T10:05:00.000Z', pA, 6),
    ...messageEvents(wsA, broadcastB, '2026-05-01T10:00:00.000Z', pB, 6),
    ...messageEvents(wsA, broadcastC, '2026-05-01T10:00:00.000Z', pC, 6),
    ...messageEvents(wsA, broadcastD, '2026-05-01T10:00:00.000Z', pD, 6),
    ...messageEvents(wsA, broadcastM, sendAt, mProfileIds, 18),
  ]);

  await t.srv.events.insert([
    // A: two conversions inside its 7-day window.
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pA[0]!,
      at: '2026-05-04T10:00:00.000Z',
      properties: { total: 10, currency: 'DKK' },
    }),
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pA[1]!,
      at: '2026-05-05T10:00:00.000Z',
      properties: { total: 20, currency: 'DKK' },
    }),
    // B: two conversions hours after the send, only inside its 1-day window.
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pB[0]!,
      at: '2026-05-01T12:00:00.000Z',
      properties: { total: 30, currency: 'DKK' },
    }),
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pB[1]!,
      at: '2026-05-01T13:00:00.000Z',
      properties: { total: 40, currency: 'DKK' },
    }),
    // C: two conversions 20 days after the send, only inside its 30-day window.
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pC[0]!,
      at: '2026-05-21T10:00:00.000Z',
      properties: { total: 50, currency: 'DKK' },
    }),
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      profileId: pC[1]!,
      at: '2026-05-22T10:00:00.000Z',
      properties: { total: 60, currency: 'DKK' },
    }),
    // M: the conversion is recorded under an anonymous id, before that id is merged into the
    // recipient (#590). Its ClickHouse profile id stays empty, as an event of an anonymous
    // visitor is.
    conversion({
      workspaceId: wsA,
      name: 'Order Completed',
      anonymousId: 'anon-merge-m0',
      at: '2026-05-10T11:00:00.000Z',
      properties: { total: 70, currency: 'DKK' },
    }),
  ]);

  const hash = holdoutHashVersion(50);
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
    [wsA, campaignM, hash, '2026-05-10T09:00:00.000Z', mProfileIds.slice(0, 10)],
  );
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'treatment', $4 FROM unnest($5::text[]) AS x`,
    [wsA, campaignM, hash, '2026-05-10T09:00:00.000Z', mProfileIds.slice(10)],
  );

  // The anonymous id becomes a profile of its own, then the identify with M0's user id merges it
  // into M0, the older profile and the campaign recipient.
  await ingest(sourceKey, [{ type: 'identify', anonymousId: 'anon-merge-m0' }]);
  const anonymousProfile = await eventually(
    async () => {
      const rows = await t.srv.db.admin.query<{ profile_id: string }>(
        `SELECT profile_id FROM identifiers WHERE workspace_id = $1 AND type = 'anonymous_id' AND value = 'anon-merge-m0'`,
        [wsA],
      );
      return rows.rows[0]?.profile_id ?? null;
    },
    (id) => !!id && id !== mProfileIds[0],
    20_000,
  );
  await ingest(sourceKey, [{ type: 'identify', anonymousId: 'anon-merge-m0', userId: mPeople[0]!.userId }]);
  await eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ merged_into: string | null }>(`SELECT merged_into FROM profiles WHERE workspace_id = $1 AND id = $2`, [
          wsA,
          anonymousProfile,
        ])
      ).rows[0]?.merged_into ?? null,
    (id) => id === mProfileIds[0],
    20_000,
  );

  // wsB: a revenue goal with no conversion map published.
  const tplB = await api(wsB).call('artifacts.create', {
    type: 'email_template',
    name: 'Renewal issue',
    content: { purpose: 'marketing_email', subject: 'Renewal', mjml },
  });
  const segB = await api(wsB).call('artifacts.create', {
    type: 'segment',
    name: 'Renewal subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  const broadcastR = await api(wsB).call('artifacts.create', {
    type: 'broadcast',
    name: 'Renewal broadcast',
    content: { template: tplB.artifactId, segment: segB.artifactId },
  });
  await api(wsB).call('artifacts.requestPublishBundle', {
    artifactIds: [tplB.artifactId, segB.artifactId, broadcastR.artifactId],
    note: 'renewal prerequisites',
  });
  campaignR = await createCampaign(wsB, 'Renewal campaign', [broadcastR.artifactId], {
    kind: 'revenue',
    event: 'Renewal Complete',
    days: 7,
    controlGroup: { percent: 50, minSampleSize: 1 },
  });
  await api(wsB).call('artifacts.requestPublish', { artifactId: campaignR, note: 'renewal campaign' });

  const rPeople = Array.from({ length: 10 }, person);
  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, p FROM unnest($2::text[]) AS p ON CONFLICT DO NOTHING`, [
    wsB,
    rPeople,
  ]);
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
    [wsB, campaignR, hash, '2026-05-11T09:00:00.000Z', rPeople.slice(0, 5)],
  );
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'treatment', $4 FROM unnest($5::text[]) AS x`,
    [wsB, campaignR, hash, '2026-05-11T09:00:00.000Z', rPeople.slice(5)],
  );
  await t.srv.events.insert(
    rPeople
      .slice(5, 8)
      .map((profileId, i) => conversion({ workspaceId: wsB, name: 'Renewal Complete', profileId, at: `2026-05-11T1${i}:00:00.000Z` })),
  );
}, 180_000);

afterAll(() => t?.close());

describe('campaign attribution window (#629)', () => {
  it('uses each campaign’s own window when an earlier campaign has two sending members', async () => {
    const result = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters'],
      dimensions: ['campaign'],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignA, campaignB, campaignC] },
    });
    const rows = Object.fromEntries(result.rows.map((r) => [r[columnIndex(result, 'campaign')], r]));

    expect(rows[campaignA]).toBeDefined();
    expect(rows[campaignB]).toBeDefined();
    expect(rows[campaignC]).toBeDefined();
    for (const id of [campaignA, campaignB, campaignC]) {
      expect(rows[id]![columnIndex(result, 'campaign.recipients')]).toBe(6);
    }
    expect(rows[campaignA]![columnIndex(result, 'campaign.converters')]).toBe(2);
    // B allows one day: only its conversions hours after the send count.
    expect(rows[campaignB]![columnIndex(result, 'campaign.converters')]).toBe(2);
    // C allows 30 days: its conversions 20 days after the send count, inside no other window.
    expect(rows[campaignC]![columnIndex(result, 'campaign.converters')]).toBe(2);
  });
});

describe('campaign revenue without conversions (#630)', () => {
  it('keeps a campaign with recipients and no conversions, with revenue 0', async () => {
    const byCampaign = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.revenue'],
      dimensions: ['campaign'],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignD] },
    });
    expect(byCampaign.rows).toHaveLength(1);
    expect(cell(byCampaign, 0, 'campaign')).toBe(campaignD);
    expect(cell(byCampaign, 0, 'currency')).toBeNull();
    expect(cell(byCampaign, 0, 'campaign.recipients')).toBe(6);
    expect(cell(byCampaign, 0, 'campaign.revenue')).toBe(0);
  });

  it('keeps the total row for a campaign with recipients and no conversions', async () => {
    const totals = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.revenue'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignD] },
    });
    expect(totals.rows).toHaveLength(1);
    expect(cell(totals, 0, 'currency')).toBeNull();
    expect(cell(totals, 0, 'campaign.recipients')).toBe(6);
    expect(cell(totals, 0, 'campaign.revenue')).toBe(0);
  });
});

describe('one identity resolution for the headline and the holdout card (#590)', () => {
  it('counts a conversion recorded under an anonymous id before a merge in both surfaces', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignM, from: '2026-05-01T00:00:00.000Z', to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignM });
    expect(summary.headline.converters).toBe(1);
    expect(holdout.control.converted! + holdout.treatment.converted!).toBe(1);
    expect(summary.headline.converters).toBe(holdout.control.converted! + holdout.treatment.converted!);
    // The per-member row reads conversions the same way as the headline.
    expect(summary.members.map((m) => m.converters)).toEqual([1]);
  });
});

describe('a revenue goal without a conversion map (#632)', () => {
  it('counts the goal event in the holdout and suppresses the zero revenue below k', async () => {
    const result = await api(wsB).call('campaigns.holdoutResult', { campaignId: campaignR });
    expect(result.goal).toMatchObject({ kind: 'revenue', event: 'Renewal Complete', attributionDays: 7 });
    expect(result.control.converted).toBe(0);
    expect(result.treatment.converted).toBe(3);
    // A missing rule values each event at 0, but the currency has three converters, below k=5, so
    // the per-currency floor keeps the key with a null amount (#901) instead of publishing a figure.
    expect(result.treatment.revenue).toEqual({ UNKNOWN: null });
    expect(result.suppressedRevenue).toBe(1);
    expect(result.note).toContain('fewer than k=5 people converted in that currency');
  });
});
