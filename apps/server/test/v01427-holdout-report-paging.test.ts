import { setHoldoutReportPageSizeForTests } from '@agentic-marketing/campaigns';
import type { BusEvent, MessageEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #972: campaigns.holdoutResult used to load the campaign's whole assignment history, pick each
// person's winner in JavaScript and keep every person in memory for the ClickHouse event query.
// The winners are chosen in SQL now and the report reads the people, their conversion events and
// their unsubscribes in bounded pages. The report must not change with the page size, and each
// page's event query must be scoped to that page.

const PORT = testPort(3525);
const DB = 'test_v01427_holdout_paging';
const PAGE = 4;
const CONTROL = 13;
const TREATMENT = 12;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let template = '';
let segment = '';
let broadcast = '';
let conversionCampaign = '';
let revenueCampaign = '';
let aliasCampaign = '';

const stamp = Date.now();
const api = () => t.api(owner, ws);
const profileIdFor = (n: number) => `prf_${n.toString(16).padStart(32, '0')}`;
const control = Array.from({ length: CONTROL }, (_, i) => profileIdFor(0x100 + i));
const treatment = Array.from({ length: TREATMENT }, (_, i) => profileIdFor(0x200 + i));
const revenueControl = Array.from({ length: CONTROL }, (_, i) => profileIdFor(0x300 + i));
const revenueTreatment = Array.from({ length: TREATMENT }, (_, i) => profileIdFor(0x400 + i));
const aliasControl = Array.from({ length: CONTROL }, (_, i) => profileIdFor(0x500 + i));
const aliasTreatment = Array.from({ length: TREATMENT }, (_, i) => profileIdFor(0x600 + i));
// One alias person was reached under a profile merged into them (0x600…): their holding row and
// one conversion sit on the alias, and one conversion carries only the alias's user id.
const alias = profileIdFor(0x900);
const mergedUserId = 'paged-merged-user';

const assignedAt = new Date(Date.now() - 2 * 86_400_000);
const convertAt = new Date(assignedAt.getTime() + 86_400_000).toISOString();
const outside = new Date(assignedAt.getTime() + 8 * 86_400_000).toISOString();
let eventSeq = 0;

const event = (name: string, profileId: string, properties: Record<string, unknown> = {}, userId = ''): BusEvent => ({
  workspaceId: ws,
  sourceId: 'test',
  messageId: `v01427_${eventSeq++}`,
  type: 'track',
  name,
  anonymousId: '',
  userId,
  profileId,
  timestamp: convertAt,
  receivedAt: convertAt,
  properties,
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const unsubscribe = (broadcastId: string, profileId: string, i: number): MessageEvent => ({
  workspaceId: ws,
  messageId: `msg_v01427_${i}`,
  eventId: `v01427_unsub_${i}`,
  type: 'unsubscribed',
  at: convertAt,
  profileId,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: template,
  templateVersion: 1,
  journeyId: broadcastId,
  variant: '',
  reason: '',
  url: '',
});

async function createCampaign(name: string, goal: object, members: { artifactId: string; role: 'primary' }[] = []) {
  const created = await api().call('artifacts.create', {
    type: 'campaign',
    name,
    content: { goal, controlGroup: { percent: 50, minSampleSize: 100 }, members },
  });
  await api().call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'paged holdout report' });
  return created.artifactId;
}

async function addPeople(ids: string[]) {
  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x ON CONFLICT DO NOTHING`, [
    ws,
    ids,
  ]);
}

async function assign(campaignId: string, arm: 'control' | 'treatment', ids: string[]) {
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, $4, $5 FROM unnest($6::text[]) AS x`,
    [ws, campaignId, holdoutHashVersion(50), arm, assignedAt, ids],
  );
}

/** Runs the report for one page size, restoring the production default afterwards. */
async function resultAt(campaignId: string, pageSize: number | null) {
  setHoldoutReportPageSizeForTests(pageSize);
  try {
    return await api().call('campaigns.holdoutResult', { campaignId });
  } finally {
    setHoldoutReportPageSizeForTests(null);
  }
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-holdout-paging-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');

  const connection = await api().call('connections.create', {
    connector: 'meta_ads',
    name: 'Paging Meta',
    settings: { pixelId: '1234567890' },
    secrets: { accessToken: 'test-access-token-1234567890' },
  });
  const map = await api().call('artifacts.create', {
    type: 'conversion_map',
    name: 'Paging revenue map',
    content: {
      rules: [
        {
          event: 'Campaign Revenue',
          value: 'order.total',
          currencyProperty: 'order.currency',
          meta: { connection: connection.id, eventName: 'Purchase' },
        },
      ],
    },
  });
  await api().call('artifacts.requestPublish', { artifactId: map.artifactId, note: 'paging revenue map' });

  template = (
    await api().call('artifacts.create', {
      type: 'email_template',
      name: 'Paging issue',
      content: {
        purpose: 'marketing_email',
        subject: 'Paging issue',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Paging</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    })
  ).artifactId;
  segment = (
    await api().call('artifacts.create', {
      type: 'segment',
      name: 'Paging subscribers',
      content: { condition: { consent: 'marketing_email' } },
    })
  ).artifactId;
  await api().call('artifacts.requestPublishBundle', { artifactIds: [template, segment], note: 'paging prerequisites' });
  broadcast = (await api().call('artifacts.create', { type: 'broadcast', name: 'Paging broadcast', content: { template, segment } }))
    .artifactId;
  await api().call('artifacts.requestPublish', { artifactId: broadcast, note: 'paging member' });

  conversionCampaign = await createCampaign(
    'Paged conversion report',
    { kind: 'conversion', event: 'Campaign Purchase', attributionDays: 7 },
    [{ artifactId: broadcast, role: 'primary' }],
  );
  revenueCampaign = await createCampaign('Paged revenue report', {
    kind: 'revenue',
    event: 'Campaign Revenue',
    attributionDays: 7,
  });
  aliasCampaign = await createCampaign('Paged alias report', {
    kind: 'conversion',
    event: 'Campaign Purchase',
    attributionDays: 7,
  });

  await addPeople([...control, ...treatment, ...revenueControl, ...revenueTreatment, ...aliasControl, ...aliasTreatment, alias]);
  await t.srv.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, alias, aliasTreatment[0]!]);
  await t.srv.db.admin.query(`INSERT INTO identifiers (workspace_id, type, value, profile_id) VALUES ($1, 'user_id', $2, $3)`, [
    ws,
    mergedUserId,
    alias,
  ]);

  await assign(conversionCampaign, 'control', control);
  await assign(conversionCampaign, 'treatment', treatment);
  await assign(revenueCampaign, 'control', revenueControl);
  await assign(revenueCampaign, 'treatment', revenueTreatment);
  await assign(aliasCampaign, 'control', aliasControl);
  await assign(aliasCampaign, 'treatment', aliasTreatment);
  await assign(aliasCampaign, 'treatment', [alias]);

  await t.srv.events.insert([
    // Conversion campaign: six control and four treatment people convert, and five people
    // unsubscribe from the campaign's own broadcast (two control, three treatment).
    ...control.slice(0, 6).map((profile) => event('Campaign Purchase', profile)),
    ...treatment.slice(0, 4).map((profile) => event('Campaign Purchase', profile)),
    // Revenue campaign: six control buyers in USD (one buys twice), two in DKK (below k, so the
    // amount is withheld), and five treatment buyers in USD.
    ...revenueControl.slice(0, 6).map((profile) => event('Campaign Revenue', profile, { order: { total: 10, currency: 'USD' } })),
    event('Campaign Revenue', revenueControl[0]!, { order: { total: 10, currency: 'USD' } }),
    ...revenueControl.slice(0, 2).map((profile) => event('Campaign Revenue', profile, { order: { total: 5, currency: 'DKK' } })),
    ...revenueTreatment.slice(0, 5).map((profile) => event('Campaign Revenue', profile, { order: { total: 20, currency: 'USD' } })),
    // A conversion outside the attribution window must not count.
    { ...event('Campaign Revenue', revenueControl[6]!, { order: { total: 99, currency: 'USD' } }), timestamp: outside },
  ]);
  await t.srv.events.insert(
    [
      ...aliasControl.slice(0, 6).map((profile) => event('Campaign Purchase', profile)),
      ...aliasTreatment.slice(1, 4).map((profile) => event('Campaign Purchase', profile)),
      // Both of these belong to aliasTreatment[0] through the merge and identifier maps.
      event('Campaign Purchase', alias),
      event('Campaign Purchase', '', {}, mergedUserId),
    ].map((e) => ({ ...e, timestamp: convertAt })),
  );
  await t.srv.events.insertMessageEvents([
    unsubscribe(broadcast, control[0]!, 0),
    unsubscribe(broadcast, control[1]!, 1),
    unsubscribe(broadcast, treatment[0]!, 2),
    unsubscribe(broadcast, treatment[1]!, 3),
    unsubscribe(broadcast, treatment[2]!, 4),
  ]);
}, 180_000);

afterAll(() => t?.close());

describe('paged holdout report (#972)', () => {
  it('reads the people and their events in bounded pages and returns the unpaged result', async () => {
    const unpaged = await api().call('campaigns.holdoutResult', { campaignId: conversionCampaign });
    expect([unpaged.control.entered, unpaged.treatment.entered]).toEqual([CONTROL, TREATMENT]);
    expect([unpaged.control.converted, unpaged.treatment.converted]).toEqual([6, 4]);
    expect([unpaged.control.unsubscribed, unpaged.treatment.unsubscribed]).toEqual([2, 3]);
    expect(unpaged.suppressed).toBe(false);

    const conversionSpy = vi.spyOn(t.srv.events, 'conversionEvents');
    const unsubscribeSpy = vi.spyOn(t.srv.events, 'unsubscribedProfiles');
    try {
      const paged = await resultAt(conversionCampaign, PAGE);
      expect(paged).toEqual(unpaged);

      // More people than one page means more than one scoped event query. Every query is bounded by
      // the page and folds its events through onPage instead of collecting the whole page's events.
      expect(conversionSpy.mock.calls.length).toBeGreaterThan(1);
      for (const [, q] of conversionSpy.mock.calls) {
        expect(q.onPage).toBeTypeOf('function');
        expect(q.profileIds!.length).toBeLessThanOrEqual(PAGE);
        expect(new Set(q.profileIds).size).toBe(q.profileIds!.length);
      }
      // The guardrail is read per winner page too, not once for the whole campaign.
      expect(unsubscribeSpy.mock.calls.length).toBe(conversionSpy.mock.calls.length);
      for (const [, q] of unsubscribeSpy.mock.calls) expect(q.profileIds!.length).toBeLessThanOrEqual(PAGE);
    } finally {
      conversionSpy.mockRestore();
      unsubscribeSpy.mockRestore();
    }
  }, 120_000);

  it('returns the same revenue and per-currency buyer floors across pages', async () => {
    const unpaged = await api().call('campaigns.holdoutResult', { campaignId: revenueCampaign });
    expect([unpaged.control.converted, unpaged.treatment.converted]).toEqual([6, 5]);
    // USD has six and five distinct buyers, so it stays visible; DKK has two control buyers, so its
    // amount is withheld even across pages.
    expect(unpaged.control.revenue).toEqual({ USD: 70, DKK: null });
    expect(unpaged.treatment.revenue).toEqual({ USD: 100 });
    expect(unpaged.suppressedRevenue).toBe(1);
    expect(unpaged.suppressed).toBe(false);

    const paged = await resultAt(revenueCampaign, PAGE);
    expect(paged).toEqual(unpaged);
  }, 120_000);

  it('resolves a merged alias and its identifier when the person is on a later page', async () => {
    const unpaged = await api().call('campaigns.holdoutResult', { campaignId: aliasCampaign });
    // aliasTreatment[0] is reached by the alias assignment, the merged profile id and the user id;
    // all three rows count as one person, and the other three treatment people convert directly.
    expect([unpaged.control.converted, unpaged.treatment.converted]).toEqual([6, 4]);

    const spy = vi.spyOn(t.srv.events, 'conversionEvents');
    try {
      const paged = await resultAt(aliasCampaign, PAGE);
      expect(paged).toEqual(unpaged);
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      // The page holding the survivor also carries its merged-away profile id and its user id.
      const aliasPage = spy.mock.calls.find(([, q]) => q.profileIds!.includes(alias));
      expect(aliasPage).toBeDefined();
      expect(aliasPage![1].profileIds!.length).toBeLessThanOrEqual(PAGE + 1);
      expect(aliasPage![1].identifiers!.userIds).toContain(mergedUserId);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
