import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, type User } from './harness';

// Phase 16 (#66): campaign evaluation. A campaign with a broadcast and a journey, events written
// straight into the same ClickHouse tables the workers use, and the campaign dimension, filter,
// attribution window and summary an agent gets over MCP.

const PORT = 3481;
const TZ = 'Europe/Stockholm';
const FROM = '2026-02-28T00:00:00.000Z';
const TO = '2026-03-10T00:00:00.000Z';
const WIDE_FROM = '2026-02-01T00:00:00.000Z';
const WIDE_TO = '2026-04-01T00:00:00.000Z';
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let campaignA = '';
let campaignSmall = '';
let campaignNew = '';
let campaignOther = '';
let template = '';
let segment = '';
let broadcastA = '';
let broadcastSmall = '';
let broadcastNew = '';
let broadcastOther = '';
let journeyA = '';
let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;
const api = (workspaceId = wsA) => t.api(owner, workspaceId);

const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

function messageEvents(workspaceId: string, memberId: string, at: string, people: string[], counts: number[]): MessageEvent[] {
  const [delivered, clicked, unsubscribed, complained] = counts;
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
) {
  const created = await api().call('artifacts.create', {
    type: 'campaign',
    name,
    content: {
      startsAt: '2026-02-25T00:00:00.000Z',
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
  await api().call('artifacts.requestPublishBundle', { artifactIds: [broadcastA, broadcastSmall, broadcastNew], note: 'broadcasts' });

  const journey = await api().call('artifacts.create', {
    type: 'journey',
    name: 'Launch journey',
    content: {
      purpose: 'marketing_email',
      controlGroup: { percent: 50, minSampleSize: 5 },
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Launch Start', reentry: 'once' } },
        { id: 'email', kind: 'email', label: 'Mail', config: { template }, next: [{ to: 'goal' }] },
        { id: 'goal', kind: 'goal', label: 'Goal', config: { event: 'Order Completed', within: 'P14D' }, next: [{ to: 'done' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as never,
  });
  await api().call('artifacts.requestPublish', { artifactId: journey.artifactId, note: 'journey' });
  journeyA = journey.artifactId;

  campaignA = await createCampaign('Launch campaign', [broadcastA, journeyA], { target: 10 });
  campaignSmall = await createCampaign('Small campaign', [broadcastSmall]);
  campaignNew = await createCampaign('Not sent campaign', [broadcastNew]);
  await api().call('artifacts.requestPublishBundle', { artifactIds: [campaignA, campaignSmall, campaignNew], note: 'campaigns' });

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
  await t.srv.events.insertMessageEvents([
    ...messageEvents(wsA, broadcastA, '2026-03-01T10:00:00.000Z', pA, [5, 2, 1, 1]),
    ...messageEvents(wsA, journeyA, '2026-03-02T10:00:00.000Z', pJ, [4, 1, 1, 0]),
    ...messageEvents(wsA, broadcastSmall, '2026-03-03T10:00:00.000Z', pS, [3, 0, 0, 0]),
    ...messageEvents(wsB, broadcastOther, '2026-03-02T10:00:00.000Z', pO, [8, 4, 1, 0]),
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
      from: FROM,
      to: TO,
      order: { by: 'campaign', dir: 'asc' },
    });
    const byCurrency = Object.fromEntries(revenue.rows.map((r) => [r[columnIndex(revenue, 'currency')], r]));
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue')]).toBe(100 + 75);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue')]).toBe(50);
    expect(byCurrency.DKK?.[columnIndex(revenue, 'campaign.revenue_per_recipient')]).toBeCloseTo(17.5, 5);
    expect(byCurrency.EUR?.[columnIndex(revenue, 'campaign.revenue_per_recipient')]).toBeCloseTo(5, 5);
    expect(revenue.meta.currency).toBeNull();
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
    expect(summary.headline.revenue).toEqual([
      { currency: 'DKK', amount: 175 },
      { currency: 'EUR', amount: 50 },
    ]);
    expect(summary.headline.revenuePerRecipient).toEqual([
      { currency: 'DKK', amount: 17.5 },
      { currency: 'EUR', amount: 5 },
    ]);
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
    });
    expect(members.journey).toMatchObject({ sent: 4, delivered: 4, clickRate: 1 / 4, unsubscribeRate: 1 / 4, converters: 1 });

    expect(summary.holdouts).toHaveLength(1);
    expect(summary.holdouts[0]).toMatchObject({ journeyId: journeyA, verdict: 'treatment_better', minSampleSizeMet: true });
    expect(summary.holdouts[0]!.control).toMatchObject({ entered: 20, converted: 2 });
    expect(summary.holdouts[0]!.treatment).toMatchObject({ entered: 20, converted: 10 });

    expect(summary.meta.timeZone).toBe(TZ);
    expect(summary.meta.k).toBe(5);
    expect(summary.meta.currency).toBeNull();
    expect(summary.meta.notes.join(' ')).toContain('got a campaign message and converted within 7 days; last touch');
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
    expect(summary.meta.notes.join(' ')).toContain('last touch');
  });

  it('is tenant scoped', async () => {
    const other = await rejects(api().call('analytics.campaignSummary', { campaignId: campaignOther }));
    expect(other.message).toContain('does not exist');
    const ours = await rejects(api(wsB).call('analytics.campaignSummary', { campaignId: campaignA }));
    expect(ours.message).toContain('does not exist');
  });
});
