import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Phase 16 (#66): campaign evaluation. A campaign with a broadcast and a journey, events written
// straight into the same ClickHouse tables the workers use, and the campaign dimension, filter,
// attribution window and summary an agent gets over MCP.

const PORT = testPort(3481);
const TZ = 'Europe/Stockholm';
const FROM = '2026-02-28T00:00:00.000Z';
const TO = '2026-03-10T00:00:00.000Z';
const WIDE_FROM = '2026-02-01T00:00:00.000Z';
const WIDE_TO = '2026-04-01T00:00:00.000Z';
// A window far from WIDE, so the extra campaigns for #586–#588 and the channel scope stay out of
// the campaign-dimension expectations above.
const LATE_FROM = '2026-10-31T00:00:00.000Z';
const LATE_TO = '2026-11-05T00:00:00.000Z';
// The revenue k fixtures (#756) send in May, outside every other window in this file.
const REV_FROM = '2026-05-01T00:00:00.000Z';
const REV_TO = '2026-05-10T00:00:00.000Z';
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let campaignA = '';
let campaignSmall = '';
let campaignNew = '';
let campaignOther = '';
let campaignChannel = '';
let campaignGuard = '';
let campaignNoStart = '';
let campaignOldStart = '';
let template = '';
let segment = '';
let broadcastA = '';
let broadcastSmall = '';
let broadcastNew = '';
let broadcastOther = '';
let broadcastChannel = '';
let broadcastGuard = '';
let broadcastNoStart = '';
let broadcastOldStart = '';
let broadcastFuture = '';
let broadcastRevenueBelow = '';
let broadcastRevenueAbove = '';
let campaignRevenueBelow = '';
let campaignRevenueAbove = '';
let journeyA = '';
let journeyTiny = '';
let journeyControlSmall = '';
let journeyHealthy = '';
let campaignTiny = '';
let campaignControlSmall = '';
let campaignHealthy = '';
let campaignFuture = '';
let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;
const api = (workspaceId = wsA) => t.api(owner, workspaceId);

const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

function messageEvents(
  workspaceId: string,
  memberId: string,
  at: string,
  people: string[],
  counts: number[],
  channel = 'email',
): MessageEvent[] {
  const [delivered, clicked, unsubscribed, complained] = counts;
  const out: MessageEvent[] = [];
  const add = (type: MessageEvent['type'], i: number) =>
    out.push({
      workspaceId,
      messageId: `msg_${memberId}_${channel}_${i}`,
      eventId: `${memberId}:${channel}:${type}:${i}`,
      type,
      at,
      profileId: people[i]!,
      channel,
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
  for (let i = 0; i < clicked; i++) add('clicked', i);
  for (let i = people.length - unsubscribed; i < people.length; i++) add('unsubscribed', i);
  for (let i = people.length - complained; i < people.length; i++) add('complained', i);
  return out;
}

const goal = (workspaceId: string, profileId: string, total: number, currency: string, at: string, name = 'Order Completed'): BusEvent => ({
  workspaceId,
  sourceId: 'test',
  messageId: `conv_${profileId}`,
  type: 'track',
  name,
  anonymousId: `anon_${profileId}`,
  userId: '',
  profileId,
  timestamp: at,
  receivedAt: at,
  properties: { total, currency },
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const journeyEvent = (
  workspaceId: string,
  journeyId: string,
  profileId: string,
  type: JourneyEvent['type'],
  seq: number,
  at: string,
): JourneyEvent => ({
  workspaceId,
  journeyId,
  version: 1,
  participantId: Number.parseInt(profileId.slice(-8), 16),
  profileId,
  node: type === 'entered' ? 'trigger' : 'goal',
  type,
  seq,
  at,
  detail: '',
});

const columnIndex = (result: { columns: { name: string }[] }, name: string) => result.columns.findIndex((c) => c.name === name);
const cell = (result: { columns: { name: string }[]; rows: (string | number | null)[][] }, row: number, name: string) =>
  result.rows[row]![columnIndex(result, name)];

async function createCampaign(
  name: string,
  members: string[],
  goalInput: { kind?: 'conversion' | 'revenue'; days?: number; target?: number } = {},
  startsAt: string | null = '2026-02-25T00:00:00.000Z',
) {
  const created = await api().call('artifacts.create', {
    type: 'campaign',
    name,
    content: {
      ...(startsAt ? { startsAt } : {}),
      goal: {
        kind: goalInput.kind ?? 'conversion',
        event: 'Order Completed',
        attributionDays: goalInput.days ?? 7,
        ...(goalInput.target ? { target: goalInput.target } : {}),
      },
      members: members.map((artifactId) => ({ artifactId, role: 'primary' })),
    },
  });
  return created.artifactId;
}

beforeAll(async () => {
  t = await startTestServer('test_v029_campaign_evaluation', PORT);
  owner = await t.signUp(`owner-campaign-eval-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']], 'none');
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('workspace.update', { timeZone: TZ });

  // A real conversion map, so revenue follows the same rules the delivery path uses.
  const connection = await api().call('connections.create', {
    connector: 'meta_ads',
    name: 'Meta evaluation',
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
  await api().call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'campaign evaluation' });

  const tpl = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'Campaign issue',
    content: { purpose: 'marketing_email', subject: 'The issue', mjml },
  });
  template = tpl.artifactId;
  const seg = await api().call('artifacts.create', {
    type: 'segment',
    name: 'Subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  segment = seg.artifactId;
  await api().call('artifacts.requestPublishBundle', { artifactIds: [template, segment], note: 'campaign evaluation prerequisites' });

  const broadcast = async (name: string) => {
    const b = await api().call('artifacts.create', { type: 'broadcast', name, content: { template, segment } });
    return b.artifactId;
  };
  broadcastA = await broadcast('Launch broadcast');
  broadcastSmall = await broadcast('Small broadcast');
  broadcastNew = await broadcast('New broadcast');
  broadcastChannel = await broadcast('Channel broadcast');
  broadcastGuard = await broadcast('Guard broadcast');
  broadcastNoStart = await broadcast('No-start broadcast');
  broadcastOldStart = await broadcast('Old-start broadcast');
  broadcastFuture = await broadcast('Future broadcast');
  broadcastRevenueBelow = await broadcast('Revenue below k broadcast');
  broadcastRevenueAbove = await broadcast('Revenue above k broadcast');
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [
      broadcastA,
      broadcastSmall,
      broadcastNew,
      broadcastChannel,
      broadcastGuard,
      broadcastNoStart,
      broadcastOldStart,
      broadcastFuture,
      broadcastRevenueBelow,
      broadcastRevenueAbove,
    ],
    note: 'broadcasts',
  });

  const journeyContent = {
    purpose: 'marketing_email',
    controlGroup: { percent: 50, minSampleSize: 5 },
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Launch Start', reentry: 'once' } },
      { id: 'email', kind: 'email', label: 'Mail', config: { template }, next: [{ to: 'goal' }] },
      { id: 'goal', kind: 'goal', label: 'Goal', config: { event: 'Order Completed', within: 'P14D' }, next: [{ to: 'done' }] },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ],
  } as never;
  const journey = await api().call('artifacts.create', {
    type: 'journey',
    name: 'Launch journey',
    content: journeyContent,
  });
  await api().call('artifacts.requestPublish', { artifactId: journey.artifactId, note: 'journey' });
  journeyA = journey.artifactId;

  const createJourney = async (name: string) => {
    const created = await api().call('artifacts.create', { type: 'journey', name, content: journeyContent });
    await api().call('artifacts.requestPublish', { artifactId: created.artifactId, note: name });
    return created.artifactId;
  };
  journeyTiny = await createJourney('Tiny holdout journey');
  journeyControlSmall = await createJourney('Small control journey');
  journeyHealthy = await createJourney('Healthy holdout journey');

  campaignA = await createCampaign('Launch campaign', [broadcastA, journeyA], { target: 10 });
  campaignSmall = await createCampaign('Small campaign', [broadcastSmall]);
  campaignNew = await createCampaign('Not sent campaign', [broadcastNew]);
  campaignChannel = await createCampaign('Channel campaign', [broadcastChannel]);
  campaignGuard = await createCampaign('Guard campaign', [broadcastGuard]);
  campaignNoStart = await createCampaign('No start campaign', [broadcastNoStart], {}, null);
  campaignOldStart = await createCampaign('Old start campaign', [broadcastOldStart], {}, '2025-06-01T00:00:00.000Z');
  campaignTiny = await createCampaign('Tiny holdout campaign', [journeyTiny], {}, '2026-11-01T00:00:00.000Z');
  campaignControlSmall = await createCampaign('Small control campaign', [journeyControlSmall], {}, '2026-11-01T00:00:00.000Z');
  campaignHealthy = await createCampaign('Healthy holdout campaign', [journeyHealthy], {}, '2026-11-01T00:00:00.000Z');
  // A campaign that starts tomorrow: the default window must not reject its own start (#588).
  campaignFuture = await createCampaign('Future campaign', [broadcastFuture], {}, new Date(Date.now() + 86_400_000).toISOString());
  campaignRevenueBelow = await createCampaign('Revenue below k campaign', [broadcastRevenueBelow], {}, '2026-05-01T00:00:00.000Z');
  campaignRevenueAbove = await createCampaign('Revenue above k campaign', [broadcastRevenueAbove], {}, '2026-05-01T00:00:00.000Z');
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [
      campaignA,
      campaignSmall,
      campaignNew,
      campaignChannel,
      campaignGuard,
      campaignNoStart,
      campaignOldStart,
      campaignTiny,
      campaignControlSmall,
    ],
    note: 'campaigns',
  });
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [campaignHealthy, campaignFuture, campaignRevenueBelow, campaignRevenueAbove],
    note: 'holdout fixture campaigns',
  });

  // A campaign in another workspace, with its own sends; it must never appear in wsA's reports.
  const tplB = await api(wsB).call('artifacts.create', {
    type: 'email_template',
    name: 'Other issue',
    content: { purpose: 'marketing_email', subject: 'Other', mjml },
  });
  const segB = await api(wsB).call('artifacts.create', {
    type: 'segment',
    name: 'Other list',
    content: { condition: { consent: 'marketing_email' } },
  });
  const other = await api(wsB).call('artifacts.create', {
    type: 'broadcast',
    name: 'Other broadcast',
    content: { template: tplB.artifactId, segment: segB.artifactId },
  });
  broadcastOther = other.artifactId;
  campaignOther = await createCampaignIn(wsB, [broadcastOther]);
  await api(wsB).call('artifacts.requestPublish', { artifactId: campaignOther, note: 'other campaign' });

  const pA = Array.from({ length: 6 }, person);
  const pJ = Array.from({ length: 4 }, person);
  const pS = Array.from({ length: 3 }, person);
  const pO = Array.from({ length: 8 }, person);
  const pChannelEmail = Array.from({ length: 6 }, person);
  const pChannelSms = Array.from({ length: 4 }, person);
  const pGuard = Array.from({ length: 6 }, person);
  const pNoStart = Array.from({ length: 5 }, person);
  const pOldStart = Array.from({ length: 5 }, person);
  const pTiny = Array.from({ length: 3 }, person);
  const pControlSmall = Array.from({ length: 8 }, person);
  const pHealthy = Array.from({ length: 10 }, person);
  const pRevBelow = Array.from({ length: 6 }, person);
  const pRevAboveEur = Array.from({ length: 5 }, person);
  const pRevAboveDkk = Array.from({ length: 5 }, person);
  await t.srv.events.insertMessageEvents([
    ...messageEvents(wsA, broadcastA, '2026-03-01T10:00:00.000Z', pA, [5, 2, 1, 1]),
    ...messageEvents(wsA, journeyA, '2026-03-02T10:00:00.000Z', pJ, [4, 1, 1, 0]),
    ...messageEvents(wsA, broadcastSmall, '2026-03-03T10:00:00.000Z', pS, [3, 0, 0, 0]),
    ...messageEvents(wsB, broadcastOther, '2026-03-02T10:00:00.000Z', pO, [8, 4, 1, 0]),
    // E-mail and SMS through the same campaign member (#682 channel scope).
    ...messageEvents(wsA, broadcastChannel, '2026-11-01T10:00:00.000Z', pChannelEmail, [5, 2, 1, 0]),
    ...messageEvents(wsA, broadcastChannel, '2026-11-01T10:00:00.000Z', pChannelSms, [4, 0, 0, 0], 'sms'),
    // A member with enough people for k, plus a send with no profile id added inside the test.
    ...messageEvents(wsA, broadcastGuard, '2026-11-02T10:00:00.000Z', pGuard, [6, 2, 0, 0]),
    ...messageEvents(wsA, broadcastNoStart, '2026-11-01T12:00:00.000Z', pNoStart, [5, 0, 0, 0]),
    ...messageEvents(wsA, broadcastOldStart, '2026-11-01T13:00:00.000Z', pOldStart, [5, 0, 0, 0]),
    // Journey members for the holdout suppression rule (#586): 3 treatment people, a member
    // with a control arm below k, and one whose member row and both arms reach k.
    ...messageEvents(wsA, journeyTiny, '2026-11-03T10:00:00.000Z', pTiny, [3, 0, 0, 0]),
    ...messageEvents(wsA, journeyControlSmall, '2026-11-03T10:00:00.000Z', pControlSmall, [8, 0, 0, 0]),
    ...messageEvents(wsA, journeyHealthy, '2026-11-03T10:00:00.000Z', pHealthy, [10, 0, 0, 0]),
    // Revenue k (#756): six recipients with one EUR converter, and ten with five per currency.
    ...messageEvents(wsA, broadcastRevenueBelow, '2026-05-02T10:00:00.000Z', pRevBelow, [6, 0, 0, 0]),
    ...messageEvents(wsA, broadcastRevenueAbove, '2026-05-02T10:00:00.000Z', [...pRevAboveEur, ...pRevAboveDkk], [10, 0, 0, 0]),
  ]);

  await t.srv.events.insertJourneyEvents(
    [...pJ, ...pS.slice(0, 2)].map((p, i) => journeyEvent(wsA, journeyA, p, 'entered', i, '2026-03-02T10:00:00.000Z')),
  );

  // Two conversions inside the 7-day window, two outside it.
  await t.srv.events.insert([
    goal(wsA, pA[0]!, 100, 'DKK', '2026-03-01T11:00:00.000Z'),
    goal(wsA, pA[1]!, 50, 'EUR', '2026-03-05T12:00:00.000Z'),
    goal(wsA, pA[2]!, 25, 'DKK', '2026-03-09T12:00:00.000Z'),
    goal(wsA, pJ[0]!, 75, 'DKK', '2026-03-04T12:00:00.000Z'),
    goal(wsA, pJ[1]!, 40, 'EUR', '2026-03-14T12:00:00.000Z'),
    goal(wsB, pO[0]!, 500, 'DKK', '2026-03-02T11:00:00.000Z'),
    // Three conversions among the e-mail recipients of the multi-channel campaign.
    goal(wsA, pChannelEmail[0]!, 100, 'DKK', '2026-11-01T11:00:00.000Z'),
    goal(wsA, pChannelEmail[1]!, 50, 'DKK', '2026-11-01T11:30:00.000Z'),
    goal(wsA, pChannelEmail[2]!, 25, 'DKK', '2026-11-01T12:00:00.000Z'),
    // One EUR converter in the six-recipient campaign, and five per currency in the other.
    goal(wsA, pRevBelow[0]!, 2499, 'EUR', '2026-05-02T11:00:00.000Z'),
    // Five DKK converters among the same six people: the campaign clears k overall while EUR still
    // has one buyer, so the EUR revenue must stay hidden (#756 with #779).
    ...pRevBelow.slice(1, 6).map((p, i) => goal(wsA, p, 20, 'DKK', `2026-05-02T12:0${i}:00.000Z`)),
    ...pRevAboveEur.map((p, i) => goal(wsA, p, 10, 'EUR', `2026-05-02T11:0${i}:00.000Z`)),
    ...pRevAboveDkk.map((p, i) => goal(wsA, p, 20, 'DKK', `2026-05-02T11:1${i}:00.000Z`)),
  ]);

  // A journey control group large enough for a verdict, with outcomes for both arms.
  const hashVersion = holdoutHashVersion(50);
  const control = Array.from({ length: 20 }, (_, i) => `prf_${(1000 + i).toString(16).padStart(32, '0')}`);
  const treatment = Array.from({ length: 20 }, (_, i) => `prf_${(2000 + i).toString(16).padStart(32, '0')}`);
  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, p FROM unnest($2::text[]) AS p ON CONFLICT DO NOTHING`, [
    wsA,
    [...control, ...treatment],
  ]);
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'journey', $2, $3, p, a, '2026-03-02T10:00:00.000Z' FROM unnest($4::text[], $5::text[]) AS t(p, a)`,
    [wsA, journeyA, hashVersion, [...control, ...treatment], [...control.map(() => 'control'), ...treatment.map(() => 'treatment')]],
  );
  const converted = [...control.slice(0, 2), ...treatment.slice(0, 10)];
  await t.srv.events.insertJourneyEvents(
    converted.map((p, i) => journeyEvent(wsA, journeyA, p, 'converted', 100 + i, '2026-03-05T10:00:00.000Z')),
  );

  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, p FROM unnest($2::text[]) AS p ON CONFLICT DO NOTHING`, [
    wsA,
    [...pTiny, ...pControlSmall, ...pHealthy],
  ]);
  const assignJourney = async (journeyId: string, controlPeople: string[], treatmentPeople: string[]) => {
    for (const [arm, people] of [
      ['control', controlPeople],
      ['treatment', treatmentPeople],
    ] as const) {
      if (!people.length) continue;
      await t.srv.db.admin.query(
        `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
         SELECT $1, 'journey', $2, $3, p, $4, '2026-11-03T09:00:00.000Z' FROM unnest($5::text[]) AS p`,
        [wsA, journeyId, hashVersion, arm, people],
      );
    }
  };
  await assignJourney(journeyTiny, [], pTiny);
  await assignJourney(journeyControlSmall, pControlSmall.slice(0, 2), pControlSmall.slice(2));
  await assignJourney(journeyHealthy, pHealthy.slice(0, 5), pHealthy.slice(5));
}, 90_000);

async function createCampaignIn(workspaceId: string, members: string[]) {
  const created = await api(workspaceId).call('artifacts.create', {
    type: 'campaign',
    name: 'Other campaign',
    content: {
      goal: { kind: 'conversion', event: 'Order Completed', attributionDays: 7 },
      members: members.map((artifactId) => ({ artifactId, role: 'primary' })),
    },
  });
  return created.artifactId;
}

afterAll(async () => {
  await t.close();
});

describe('campaign dimension and filter', () => {
  it('maps message and journey events to published campaigns and suppresses small groups', async () => {
    const byCampaign = await api().call('analytics.query', {
      measures: ['email.sent'],
      dimensions: ['campaign'],
      from: WIDE_FROM,
      to: WIDE_TO,
      order: { by: 'campaign', dir: 'asc' },
    });
    const rowOf = new Map(byCampaign.rows.map((r, i) => [String(r[columnIndex(byCampaign, 'campaign')]), i]));
    expect(new Set(rowOf.keys())).toEqual(new Set([campaignA, campaignSmall]));
    expect(cell(byCampaign, rowOf.get(campaignA)!, 'email.sent')).toBe(10);
    expect(cell(byCampaign, rowOf.get(campaignSmall)!, 'email.sent')).toBeNull();
    expect(byCampaign.meta.suppressed).toBe(1);

    const filtered = await api().call('analytics.query', {
      measures: ['email.sent'],
      dimensions: [],
      from: WIDE_FROM,
      to: WIDE_TO,
      filters: { campaign: [campaignA] },
    });
    expect(filtered.rows).toEqual([[10]]);

    const byJourneyCampaign = await api().call('analytics.query', {
      measures: ['journey.entered'],
      dimensions: ['campaign'],
      from: WIDE_FROM,
      to: WIDE_TO,
    });
    expect(byJourneyCampaign.rows).toEqual([[campaignA, 6]]);
  });

  it('exposes campaign measures with the campaign dimension and filter', async () => {
    const byCampaign = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.conversion_rate'],
      dimensions: ['campaign'],
      from: WIDE_FROM,
      to: WIDE_TO,
    });
    const rows = Object.fromEntries(byCampaign.rows.map((r) => [r[columnIndex(byCampaign, 'campaign')], r]));
    expect(rows[campaignA]).toBeDefined();
    expect(rows[campaignA]![columnIndex(byCampaign, 'campaign.recipients')]).toBe(10);
    expect(rows[campaignA]![columnIndex(byCampaign, 'campaign.converters')]).toBe(3);
    expect(rows[campaignA]![columnIndex(byCampaign, 'campaign.conversion_rate')]).toBeCloseTo(0.3, 5);
    expect(rows[campaignA]![columnIndex(byCampaign, 'campaign.recipients')]).not.toBeNull();
    expect(byCampaign.meta.suppressed).toBe(1);

    const revenue = await api().call('analytics.query', {
      measures: ['campaign.revenue', 'campaign.revenue_per_recipient'],
      dimensions: ['campaign'],
      from: REV_FROM,
      to: REV_TO,
      filters: { campaign: [campaignRevenueAbove] },
      order: { by: 'campaign', dir: 'asc' },
    });
    const byCurrency = Object.fromEntries(revenue.rows.map((r) => [r[columnIndex(revenue, 'currency')], r]));
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue')]).toBe(100);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue')]).toBe(50);
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue_per_recipient')]).toBeCloseTo(10, 5);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue_per_recipient')]).toBeCloseTo(5, 5);
    expect(revenue.meta.currency).toBeNull();
    expect(revenue.meta.suppressed).toBe(0);
  });

  it('suppresses a currency revenue row whose converter count is below k (#756)', async () => {
    const revenue = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.revenue'],
      dimensions: ['campaign'],
      from: REV_FROM,
      to: REV_TO,
      filters: { campaign: [campaignRevenueBelow] },
    });
    // Six recipients, one EUR converter and five DKK converters: the campaign has six converters, so
    // the campaign row clears k, but the EUR row's subject is one person and its revenue stays null.
    // The DKK row, with five buyers, shows its revenue.
    const byCurrency = Object.fromEntries(revenue.rows.map((r) => [r[columnIndex(revenue, 'currency')], r]));
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.recipients')]).toBe(6);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.converters')]).toBe(6);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue')]).toBeNull();
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue')]).toBe(100);
    expect(revenue.meta.suppressed).toBe(1);

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignRevenueBelow, from: REV_FROM, to: REV_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.recipients).toBe(6);
    expect(summary.headline.converters).toBe(6);
    expect(summary.headline.revenue).toEqual([{ currency: 'DKK', amount: 100 }]);
    expect(summary.meta.suppressed).toBe(1);
  });

  it('shows a currency revenue row with k or more converters (#756)', async () => {
    const revenue = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.revenue'],
      dimensions: ['campaign'],
      from: REV_FROM,
      to: REV_TO,
      filters: { campaign: [campaignRevenueAbove] },
      order: { by: 'campaign', dir: 'asc' },
    });
    const byCurrency = Object.fromEntries(revenue.rows.map((r) => [r[columnIndex(revenue, 'currency')], r]));
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.recipients')]).toBe(10);
    // Since #779 converters are the campaign's total on every currency row (5 EUR + 5 DKK
    // buyers); the revenue k floor still counts the converters in each currency (#756).
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.converters')]).toBe(10);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue')]).toBe(50);
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.converters')]).toBe(10);
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue')]).toBe(100);
    expect(revenue.meta.suppressed).toBe(0);

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignRevenueAbove, from: REV_FROM, to: REV_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.revenue).toEqual([
      { currency: 'DKK', amount: 100 },
      { currency: 'EUR', amount: 50 },
    ]);
  });

  it('keeps converters and the conversion rate independent of a revenue measure (#779)', async () => {
    const withoutRevenue = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.conversion_rate'],
      dimensions: ['campaign'],
      from: FROM,
      to: TO,
      order: { by: 'campaign', dir: 'asc' },
    });
    const withRevenue = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters', 'campaign.conversion_rate', 'campaign.revenue'],
      dimensions: ['campaign'],
      from: FROM,
      to: TO,
      order: { by: 'campaign', dir: 'asc' },
    });

    const convertersOf = (result: typeof withoutRevenue, campaign: string) => {
      const campaignIndex = columnIndex(result, 'campaign');
      const convertersIndex = columnIndex(result, 'campaign.converters');
      const rateIndex = columnIndex(result, 'campaign.conversion_rate');
      const row = result.rows.find((r) => r[campaignIndex] === campaign)!;
      return { converters: row[convertersIndex], rate: row[rateIndex] };
    };
    const plain = convertersOf(withoutRevenue, campaignA);
    // The defect split the same campaign into one row per conversion currency, counting only
    // that currency's people as converters and dividing each by the all-channel recipients.
    const byCurrency = new Map(
      withRevenue.rows
        .filter((r) => r[columnIndex(withRevenue, 'campaign')] === campaignA)
        .map((r) => [r[columnIndex(withRevenue, 'currency')], r]),
    );
    expect(new Set(byCurrency.keys())).toEqual(new Set(['DKK', 'EUR']));
    for (const row of byCurrency.values()) {
      expect(row[columnIndex(withRevenue, 'campaign.converters')]).toBe(plain.converters);
      expect(row[columnIndex(withRevenue, 'campaign.conversion_rate')]).toBeCloseTo(plain.rate as number, 5);
    }
    expect(plain).toMatchObject({ converters: 3 });
    expect(plain.rate).toBeCloseTo(0.3, 5);
  });

  it('never sees another workspace', async () => {
    const other = await api().call('analytics.query', { measures: ['email.sent'], dimensions: ['campaign'], from: WIDE_FROM, to: WIDE_TO });
    expect(other.rows.map((r) => r[0])).not.toContain(campaignOther);

    const wsBResult = await api(wsB).call('analytics.query', {
      measures: ['email.sent'],
      dimensions: ['campaign'],
      from: WIDE_FROM,
      to: WIDE_TO,
    });
    expect(wsBResult.rows).toEqual([[campaignOther, 8]]);
  });
});

describe('analytics.campaignSummary', () => {
  it('reports the headline, funnel, per-member rows, holdout and meta', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignA, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    expect(summary.goal).toMatchObject({ kind: 'conversion', event: 'Order Completed', attributionDays: 7, target: 10 });
    expect(summary.headline.recipients).toBe(10);
    expect(summary.headline.delivered).toBe(9);
    expect(summary.headline.clickers).toBe(3);
    expect(summary.headline.unsubscribers).toBe(2);
    expect(summary.headline.complaintRate).toBeCloseTo(1 / 9, 5);
    expect(summary.headline.unsubscribeRate).toBeCloseTo(2 / 9, 5);
    expect(summary.headline.converters).toBe(3);
    expect(summary.headline.conversionRate).toBeCloseTo(0.3, 5);
    expect(summary.headline.revenue).toEqual([]);
    expect(summary.headline.revenuePerRecipient).toEqual([]);
    expect(summary.headline.targetProgress).toBeCloseTo(0.3, 5);

    expect(summary.funnel).toEqual([
      { step: 'recipients', count: 10, stepRate: null, shareOfRecipients: 1 },
      { step: 'delivered', count: 9, stepRate: 0.9, shareOfRecipients: 0.9 },
      { step: 'clicked', count: 3, stepRate: 3 / 9, shareOfRecipients: 0.3 },
      { step: 'converted', count: 3, stepRate: 1, shareOfRecipients: 0.3 },
    ]);

    const members = Object.fromEntries(summary.members.map((m) => [m.type, m]));
    expect(summary.members).toHaveLength(2);
    expect(members.broadcast).toMatchObject({
      sent: 6,
      delivered: 5,
      clickRate: 2 / 5,
      unsubscribeRate: 1 / 5,
      converters: 2,
      suppressed: false,
    });
    // The journey reached four people, below k=5: every count and rate in its row is hidden.
    expect(members.journey).toMatchObject({
      sent: null,
      delivered: null,
      clickRate: null,
      unsubscribeRate: null,
      converters: null,
      suppressed: true,
    });

    expect(summary.holdouts).toHaveLength(1);
    // The journey row reached four people, below k=5, so its holdout card is suppressed too.
    expect(summary.holdouts[0]).toMatchObject({
      journeyId: journeyA,
      suppressed: true,
      verdict: 'not_enough_data',
      minSampleSizeMet: false,
    });
    expect(summary.holdouts[0]!.control).toMatchObject({
      entered: null,
      converted: null,
      unsubscribed: null,
      conversionRate: null,
      unsubscribeRate: null,
    });
    expect(summary.holdouts[0]!.treatment).toMatchObject({
      entered: null,
      converted: null,
      unsubscribed: null,
      conversionRate: null,
      unsubscribeRate: null,
    });
    expect(summary.holdouts[0]!.absoluteLift).toBeNull();
    expect(summary.holdouts[0]!.relativeLift).toBeNull();
    expect(summary.holdouts[0]!.ci95).toBeNull();

    expect(summary.meta.timeZone).toBe(TZ);
    expect(summary.meta.k).toBe(5);
    expect(summary.meta.currency).toBeNull();
    expect(summary.meta.suppressed).toBe(4);
    expect(summary.meta.notes.join(' ')).toContain('fewer than k');
    expect(summary.meta.notes.join(' ')).toContain(
      'got a campaign message and converted within 7 days of their first campaign message (first touch)',
    );
  });

  it('suppresses a member row below k and counts it in meta.suppressed (#586)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignSmall, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    // The headline is a total, so it is never suppressed by k.
    expect(summary.headline.recipients).toBe(3);
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({
      sent: null,
      delivered: null,
      clickRate: null,
      unsubscribeRate: null,
      converters: null,
      suppressed: true,
    });
    expect(summary.meta.suppressed).toBe(1);
    expect(summary.meta.notes.join(' ')).toContain('fewer than k=5');
  });

  it('suppresses a holdout whose member row is below k (#586)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignTiny, from: LATE_FROM, to: LATE_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    // Three treatment recipients: the member row and the holdout card are both below k=5.
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({ suppressed: true, sent: null, delivered: null, converters: null });
    expect(summary.holdouts).toHaveLength(1);
    expect(summary.holdouts[0]).toMatchObject({ journeyId: journeyTiny, suppressed: true, minSampleSizeMet: false });
    expect(summary.holdouts[0]!.control).toMatchObject({ entered: null, converted: null, conversionRate: null });
    expect(summary.holdouts[0]!.treatment).toMatchObject({ entered: null, converted: null, conversionRate: null });
    expect(summary.holdouts[0]!.absoluteLift).toBeNull();
    expect(summary.holdouts[0]!.ci95).toBeNull();
    expect(summary.meta.suppressed).toBe(2);
  });

  it('suppresses a holdout whose control arm is below k (#586)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignControlSmall, from: LATE_FROM, to: LATE_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    // Eight people reached keeps the member row visible, but two control people are below k=5.
    expect(summary.members[0]).toMatchObject({ suppressed: false, sent: 8, delivered: 8 });
    expect(summary.holdouts[0]).toMatchObject({ journeyId: journeyControlSmall, suppressed: true, minSampleSizeMet: false });
    expect(summary.holdouts[0]!.control).toMatchObject({ entered: null, converted: null });
    expect(summary.holdouts[0]!.treatment).toMatchObject({ entered: null, converted: null });
    expect(summary.meta.suppressed).toBe(1);
  });

  it('keeps a holdout visible when its member row and both arms reach k (#586)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignHealthy, from: LATE_FROM, to: LATE_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    expect(summary.members[0]).toMatchObject({ suppressed: false, sent: 10, delivered: 10 });
    expect(summary.holdouts[0]).toMatchObject({ journeyId: journeyHealthy, suppressed: false });
    expect(summary.holdouts[0]!.control.entered).toBe(5);
    expect(summary.holdouts[0]!.treatment.entered).toBe(5);
    expect(summary.holdouts[0]!.control.conversionRate).toBe(0);
    expect(summary.meta.suppressed).toBe(0);
  });

  it('returns readiness for a campaign that starts tomorrow even without dates (#588)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignFuture });
    expect(summary.state).toBe('not_started');
    if (summary.state !== 'not_started') return;

    expect(summary.readiness).toMatchObject({ published: true, sendingMembers: 1, publishedSendingMembers: 1 });
    expect(Date.parse(summary.meta.from)).toBeLessThanOrEqual(Date.parse(summary.meta.to));
  });

  it('returns readiness when to is before a campaign that sent later (#747)', async () => {
    // campaignA starts on 25 February and sent from 28 February; this window ends before both.
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignA, to: '2026-02-01T00:00:00.000Z' });
    expect(summary.state).toBe('not_started');
    if (summary.state !== 'not_started') return;

    expect(summary.meta.from).toBe('2026-02-01T00:00:00.000Z');
    expect(summary.meta.to).toBe('2026-02-01T00:00:00.000Z');
    expect(Date.parse(summary.meta.from)).toBeLessThanOrEqual(Date.parse(summary.meta.to));
    expect(summary.readiness.published).toBe(true);
    expect(summary.readiness.sendingMembers).toBeGreaterThan(0);
  });

  it('does not let a send without a profile id change member counts or rates (#587)', async () => {
    const load = () => api().call('analytics.campaignSummary', { campaignId: campaignGuard, from: LATE_FROM, to: LATE_TO });
    const before = await load();
    expect(before.state).toBe('measured');
    if (before.state !== 'measured') return;
    expect(before.members).toHaveLength(1);
    expect(before.members[0]).toMatchObject({
      sent: 6,
      delivered: 6,
      clickRate: 2 / 6,
      unsubscribeRate: 0,
    });

    // The outbox can record a message without a profile id (packages/email/src/outbox.ts). It is
    // not a person and must not add a phantom denominator to the member row.
    const blank = (type: MessageEvent['type']): MessageEvent => ({
      workspaceId: wsA,
      messageId: `msg_${broadcastGuard}_blank_${type}`,
      eventId: `${broadcastGuard}:blank:${type}`,
      type,
      at: '2026-11-02T10:00:00.000Z',
      profileId: '',
      channel: 'email',
      purpose: 'marketing_email',
      provider: 'log',
      templateId: '',
      templateVersion: 1,
      journeyId: broadcastGuard,
      variant: '',
      reason: '',
      url: '',
    });
    await t.srv.events.insertMessageEvents([blank('sent'), blank('delivered')]);
    const after = await load();
    expect(after.state).toBe('measured');
    if (after.state !== 'measured') return;
    expect(after.members[0]).toMatchObject({
      sent: 6,
      delivered: 6,
      clickRate: 2 / 6,
      unsubscribeRate: 0,
    });
  });

  it('clamps the documented default window to the 400-day cap and says so (#588)', async () => {
    for (const campaignId of [campaignNoStart, campaignOldStart]) {
      const summary = await api().call('analytics.campaignSummary', { campaignId });
      expect(summary.state).toBe('measured');
      if (summary.state !== 'measured') continue;
      expect(Date.parse(summary.meta.to) - Date.parse(summary.meta.from)).toBe(400 * 86_400_000);
      expect(summary.meta.notes.join(' ')).toContain('400 days');
      expect(summary.meta.notes.join(' ')).toContain('pass from');
    }
  });

  it('rejects a reversed window with a message that names the fix (#588)', async () => {
    const error = await rejects(api().call('analytics.campaignSummary', { campaignId: campaignA, from: TO, to: FROM }));
    expect(error.message).toContain('from must be before to');
    expect(error.message).toContain('omit from');
  });

  it('keeps all-channel recipients and computes e-mail rates on the e-mail base (#682)', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignChannel, from: LATE_FROM, to: LATE_TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    // Six e-mail people plus four SMS people: recipients covers every channel, delivery is e-mail.
    expect(summary.headline.recipients).toBe(10);
    expect(summary.headline.delivered).toBe(5);
    expect(summary.headline.clickers).toBe(2);
    expect(summary.headline.converters).toBe(3);
    expect(summary.headline.conversionRate).toBeCloseTo(3 / 10, 5);

    const funnel = Object.fromEntries(summary.funnel.map((step) => [step.step, step]));
    expect(funnel.delivered).toMatchObject({ count: 5, stepRate: 5 / 6, shareOfRecipients: 5 / 6 });
    expect(funnel.clicked).toMatchObject({ count: 2, stepRate: 2 / 5, shareOfRecipients: 2 / 6 });

    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({
      sent: 6,
      delivered: 5,
      clickRate: 2 / 5,
      unsubscribeRate: 1 / 5,
      converters: 3,
      suppressed: false,
    });
    expect(summary.headline.emailSent).toBe(6);
  });

  it('scopes campaign freshness to sent and delivered for an SMS-only campaign (#760)', async () => {
    const broadcast = await api().call('artifacts.create', {
      type: 'broadcast',
      name: 'SMS-only broadcast',
      content: { template, segment },
    });
    const campaign = await createCampaign('SMS-only campaign', [broadcast.artifactId], {}, '2026-11-10T00:00:00.000Z');
    await api().call('artifacts.requestPublishBundle', {
      artifactIds: [broadcast.artifactId, campaign],
      note: 'sms freshness',
    });
    const people = Array.from({ length: 6 }, person);
    const sent = messageEvents(wsA, broadcast.artifactId, '2026-11-10T10:00:00.000Z', people, [5, 0, 0, 0], 'sms');
    // A later failed send decision: the recipient CTE never counts it, so freshness must not name
    // it either. Before #760 the campaign source took max(at) over every message event type.
    const failed: MessageEvent = {
      workspaceId: wsA,
      messageId: `msg_${broadcast.artifactId}_sms_failed`,
      eventId: `${broadcast.artifactId}:sms:failed:0`,
      type: 'failed',
      at: '2026-11-11T10:00:00.000Z',
      profileId: people[0]!,
      channel: 'sms',
      purpose: 'marketing_sms',
      provider: 'log',
      templateId: '',
      templateVersion: 1,
      journeyId: broadcast.artifactId,
      variant: '',
      reason: 'provider rejected',
      url: '',
    };
    await t.srv.events.insertMessageEvents([...sent, failed]);

    const from = '2026-11-10T00:00:00.000Z';
    const to = '2026-11-12T00:00:00.000Z';
    const query = await api().call('analytics.query', {
      measures: ['campaign.recipients'],
      filters: { campaign: [campaign] },
      from,
      to,
    });
    expect(query.meta.freshness).toBe('2026-11-10T10:00:00.000Z');

    // The summary falls back to the campaign-source freshness when it has no e-mail events.
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaign, from, to });
    expect(summary.state).toBe('measured');
    expect(summary.meta.freshness).toBe('2026-11-10T10:00:00.000Z');
  });

  it('measures an archived campaign by id with a headline that matches its member rows (#780)', async () => {
    const broadcast = await api().call('artifacts.create', {
      type: 'broadcast',
      name: 'Archived broadcast',
      content: { template, segment },
    });
    const campaign = await createCampaign('Archived campaign', [broadcast.artifactId], {}, '2026-11-08T00:00:00.000Z');
    await api().call('artifacts.requestPublishBundle', {
      artifactIds: [broadcast.artifactId, campaign],
      note: 'archived campaign',
    });
    const people = Array.from({ length: 6 }, person);
    await t.srv.events.insertMessageEvents(messageEvents(wsA, broadcast.artifactId, '2026-11-08T10:00:00.000Z', people, [5, 2, 0, 0]));
    await t.srv.events.insert([
      goal(wsA, people[0]!, 30, 'DKK', '2026-11-08T11:00:00.000Z'),
      goal(wsA, people[1]!, 20, 'DKK', '2026-11-09T09:00:00.000Z'),
    ]);
    await api().call('campaigns.archive', { campaignId: campaign });

    const summary = await api().call('analytics.campaignSummary', {
      campaignId: campaign,
      from: '2026-11-08T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
    });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;

    // The headline and the member rows must describe the same population. Before #780 the
    // headline resolved through the non-archived query map (all zeros) while members did not.
    expect(summary.headline.recipients).toBe(6);
    expect(summary.headline.delivered).toBe(5);
    expect(summary.headline.converters).toBe(2);
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({
      artifactId: broadcast.artifactId,
      sent: 6,
      delivered: 5,
      converters: 2,
      suppressed: false,
    });
  });

  it('returns readiness instead of zeros before the first send', async () => {
    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignNew });
    expect(summary.state).toBe('not_started');
    if (summary.state !== 'not_started') return;
    expect(summary.readiness).toMatchObject({
      published: true,
      membersPublished: true,
      sendingMembers: 1,
      publishedSendingMembers: 1,
      sendingMembersScheduled: true,
    });
    expect(summary.meta.notes.join(' ')).toContain('first touch');
  });

  it('is tenant scoped', async () => {
    const other = await rejects(api().call('analytics.campaignSummary', { campaignId: campaignOther }));
    expect(other.message).toContain('does not exist');
    const ours = await rejects(api(wsB).call('analytics.campaignSummary', { campaignId: campaignA }));
    expect(ours.message).toContain('does not exist');
  });
});
