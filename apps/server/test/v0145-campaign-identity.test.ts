import { randomUUID } from 'node:crypto';
import type { BusEvent, MessageEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// 0.14.5 (#590): identity resolution has to survive a merge on every campaign surface. A person
// reached as profile A, merged into B, must count once; a conversion stored under either side must
// match the recipient; and neither the holdout nor the headline may lose the map because unrelated
// merges elsewhere in the workspace made it large.

const PORT = testPort(3514);
const DB = 'test_v0145_campaign_identity';
const FROM = '2026-04-25T00:00:00.000Z';
const TO = '2026-06-25T00:00:00.000Z';
const ASSIGNED_AT = '2026-05-01T09:00:00.000Z';
const SEND_AT = '2026-05-01T10:00:00.000Z';
const CONVERT_AT = '2026-05-04T10:00:00.000Z';
const UNRELATED_MERGES = 2_000;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let template = '';
let segment = '';
let campaignA = '';
let campaignB = '';
let campaignC = '';
let broadcastA = '';
let broadcastB = '';
let broadcastC = '';

// Profiles are random 32-hex ids, so they cannot collide with the deterministic unrelated ids.
const profileId = () => `prf_${randomUUID().replaceAll('-', '')}`;
const pA = profileId();
const pB = profileId();
const pC = profileId();
const pD = profileId();
const pE = profileId();
const pF = profileId();
// Member rows are suppressed below k=5 people reached, so every campaign also reaches four
// unrelated people who never convert.
const extrasA = Array.from({ length: 4 }, profileId);
const extrasB = Array.from({ length: 4 }, profileId);
const extrasC = Array.from({ length: 4 }, profileId);

const stamp = Date.now();
const api = () => t.api(owner, ws);

const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

function messageEvents(memberId: string, at: string, people: string[]): MessageEvent[] {
  return people.flatMap((profileId, i) => [
    {
      workspaceId: ws,
      messageId: `msg_${memberId}_${i}`,
      eventId: `${memberId}:sent:${i}`,
      type: 'sent' as const,
      at,
      profileId,
      channel: 'email',
      purpose: 'marketing_email',
      provider: 'log',
      templateId: '',
      templateVersion: 1,
      journeyId: memberId,
      variant: '',
      reason: '',
      url: '',
    },
    {
      workspaceId: ws,
      messageId: `msg_${memberId}_${i}`,
      eventId: `${memberId}:delivered:${i}`,
      type: 'delivered' as const,
      at,
      profileId,
      channel: 'email',
      purpose: 'marketing_email',
      provider: 'log',
      templateId: '',
      templateVersion: 1,
      journeyId: memberId,
      variant: '',
      reason: '',
      url: '',
    },
  ]);
}

const conversion = (profileId: string, at = CONVERT_AT): BusEvent => ({
  workspaceId: ws,
  sourceId: 'test',
  messageId: `conv_${profileId}_${at}`,
  type: 'track',
  name: 'Order Completed',
  anonymousId: '',
  userId: '',
  profileId,
  timestamp: at,
  receivedAt: at,
  properties: { total: 10, currency: 'DKK' },
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const columnIndex = (result: { columns: { name: string }[] }, name: string) => result.columns.findIndex((c) => c.name === name);
const cell = (result: { columns: { name: string }[]; rows: (string | number | null)[][] }, name: string) =>
  result.rows[0]![columnIndex(result, name)];

async function createCampaign(name: string, memberId: string) {
  const created = await api().call('artifacts.create', {
    type: 'campaign',
    name,
    content: {
      startsAt: '2026-04-30T00:00:00.000Z',
      goal: { kind: 'conversion', event: 'Order Completed', attributionDays: 7 },
      controlGroup: { percent: 50, minSampleSize: 1 },
      members: [{ artifactId: memberId, role: 'primary' }],
    },
  });
  return created.artifactId;
}

async function assign(profile: string, campaignId: string) {
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     VALUES ($1, 'campaign', $2, $3, $4, 'treatment', $5)`,
    [ws, campaignId, holdoutHashVersion(50), profile, ASSIGNED_AT],
  );
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-campaign-identity-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');

  const tpl = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'Identity issue',
    content: { purpose: 'marketing_email', subject: 'The issue', mjml },
  });
  template = tpl.artifactId;
  const seg = await api().call('artifacts.create', {
    type: 'segment',
    name: 'Identity subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  segment = seg.artifactId;
  await api().call('artifacts.requestPublishBundle', { artifactIds: [template, segment], note: 'identity prerequisites' });

  const broadcast = async (name: string) => {
    const created = await api().call('artifacts.create', { type: 'broadcast', name, content: { template, segment } });
    return created.artifactId;
  };
  broadcastA = await broadcast('A broadcast');
  broadcastB = await broadcast('B broadcast');
  broadcastC = await broadcast('C broadcast');
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [broadcastA, broadcastB, broadcastC],
    note: 'identity members',
  });

  campaignA = await createCampaign('A campaign', broadcastA);
  campaignB = await createCampaign('B campaign', broadcastB);
  campaignC = await createCampaign('C campaign', broadcastC);
  await api().call('artifacts.requestPublishBundle', {
    artifactIds: [campaignA, campaignB, campaignC],
    note: 'identity campaigns',
  });

  // The people the campaigns reach, plus a large set of merges that have nothing to do with them.
  // Sol's review hit the 96 KiB/2,000-pair bound at 500 merges (three keys each); 2,000 merges
  // with their two identifiers are 6,000 pairs, far past the old bound.
  await t.srv.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, merged_into)
     SELECT $1, 'prf_' || lpad(to_hex(g), 32, '0'), 'prf_' || lpad(to_hex(g + 100000), 32, '0')
     FROM generate_series(1, $2) AS g ON CONFLICT DO NOTHING`,
    [ws, UNRELATED_MERGES],
  );
  await t.srv.db.admin.query(
    `INSERT INTO profiles (workspace_id, id)
     SELECT $1, 'prf_' || lpad(to_hex(g + 100000), 32, '0')
     FROM generate_series(1, $2) AS g ON CONFLICT DO NOTHING`,
    [ws, UNRELATED_MERGES],
  );
  await t.srv.db.admin.query(
    `INSERT INTO identifiers (workspace_id, type, value, profile_id)
     SELECT $1, 'user_id', 'unrelated-user-' || g, 'prf_' || lpad(to_hex(g), 32, '0')
     FROM generate_series(1, $2) AS g ON CONFLICT DO NOTHING`,
    [ws, UNRELATED_MERGES],
  );
  await t.srv.db.admin.query(
    `INSERT INTO identifiers (workspace_id, type, value, profile_id)
     SELECT $1, 'anonymous_id', 'unrelated-anon-' || g, 'prf_' || lpad(to_hex(g), 32, '0')
     FROM generate_series(1, $2) AS g ON CONFLICT DO NOTHING`,
    [ws, UNRELATED_MERGES],
  );

  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, p FROM unnest($2::text[]) AS p`, [
    ws,
    [pA, pB, pC, pD, pE, pF, ...extrasA, ...extrasB, ...extrasC],
  ]);
  // A → B, C → D and E → F: the recipient's historical profile merged into the survivor.
  await t.srv.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, pA, pB]);
  await t.srv.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, pC, pD]);
  await t.srv.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, pE, pF]);

  await t.srv.events.insertMessageEvents([
    // A received before merging into B; C received before merging into D; E and F both received.
    ...messageEvents(broadcastA, SEND_AT, [pA, ...extrasA]),
    ...messageEvents(broadcastB, SEND_AT, [pC, ...extrasB]),
    ...messageEvents(broadcastC, SEND_AT, [pE, pF, ...extrasC]),
  ]);
  await t.srv.events.insert([
    // A's conversion arrives after the merge, so ClickHouse stores it under the survivor B.
    conversion(pB),
    // C's conversion keeps the historical profile id the event was stored with.
    conversion(pC),
    // E and F are one person after the merge; the conversion is stored under the survivor.
    conversion(pF),
  ]);

  await assign(pB, campaignA);
  await assign(pD, campaignB);
  await assign(pF, campaignC);
}, 180_000);

afterAll(() => t?.close());

describe('a conversion after a merge (#590)', () => {
  it('counts it in the headline, the per-member row and the holdout', async () => {
    const headline = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignA] },
    });
    expect(cell(headline, 'campaign.recipients')).toBe(5);
    expect(cell(headline, 'campaign.converters')).toBe(1);

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignA, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.converters).toBe(1);
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({ sent: 5, converters: 1 });

    const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignA });
    expect(holdout.treatment.converted).toBe(1);
    expect(summary.headline.converters).toBe(holdout.control.converted + holdout.treatment.converted);
  });
});

describe('a workspace with thousands of unrelated merges (#590)', () => {
  it('still resolves the campaign’s own merged recipient and agrees with the holdout', async () => {
    const merges = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND merged_into IS NOT NULL`,
      [ws],
    );
    expect(merges.rows[0]!.n).toBeGreaterThan(UNRELATED_MERGES);

    const headline = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignB] },
    });
    expect(cell(headline, 'campaign.recipients')).toBe(5);
    expect(cell(headline, 'campaign.converters')).toBe(1);

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignB, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.converters).toBe(1);
    expect(summary.members[0]).toMatchObject({ sent: 5, converters: 1 });

    const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignB });
    expect(holdout.treatment.converted).toBe(1);
    expect(summary.headline.converters).toBe(holdout.control.converted + holdout.treatment.converted);
  });
});

describe('a holdout and historical profile ids (#590)', () => {
  it('counts an event stored only under the merged-away profile', async () => {
    const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignB });
    expect(holdout.treatment.entered).toBe(1);
    expect(holdout.treatment.converted).toBe(1);
  });
});

describe('a person reached as two profiles (#590)', () => {
  it('counts them once after the merge', async () => {
    const headline = await api().call('analytics.query', {
      measures: ['campaign.recipients', 'campaign.converters'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { campaign: [campaignC] },
    });
    expect(cell(headline, 'campaign.recipients')).toBe(5);
    expect(cell(headline, 'campaign.converters')).toBe(1);

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaignC, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.recipients).toBe(5);
    expect(summary.members[0]).toMatchObject({ sent: 5, converters: 1 });
  });
});
