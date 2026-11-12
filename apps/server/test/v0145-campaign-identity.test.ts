import { randomUUID } from 'node:crypto';
import { clearAnalyticsCache } from '@agentic-marketing/analytics';
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
// Holdout fillers keep both arms at k=5 without adding conversions or merges to the measured map.
const fillers = Array.from({ length: 10 }, profileId);

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

async function assign(profiles: string[], campaignId: string, arm: 'control' | 'treatment') {
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, $4, $5 FROM unnest($6::text[]) AS x`,
    [ws, campaignId, holdoutHashVersion(50), arm, ASSIGNED_AT, profiles],
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
    [pA, pB, pC, pD, pE, pF, ...extrasA, ...extrasB, ...extrasC, ...fillers],
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

  // Five people per arm so the k=5 floor does not hide the holdout this file measures (#590).
  // The fillers never convert and never merge, so they cannot change the identity assertions.
  await assign(fillers.slice(0, 5), campaignA, 'control');
  await assign([pB, ...fillers.slice(5, 9)], campaignA, 'treatment');
  await assign(fillers.slice(5, 10), campaignB, 'control');
  await assign([pD, ...fillers.slice(0, 4)], campaignB, 'treatment');
  await assign(fillers.slice(0, 5), campaignC, 'control');
  await assign([pF, ...fillers.slice(5, 9)], campaignC, 'treatment');
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
    expect(summary.headline.converters).toBe(holdout.control.converted! + holdout.treatment.converted!);
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
    expect(summary.headline.converters).toBe(holdout.control.converted! + holdout.treatment.converted!);
  });
});

describe('a holdout and historical profile ids (#590)', () => {
  it('counts an event stored only under the merged-away profile', async () => {
    const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignB });
    expect(holdout.treatment.entered).toBe(5);
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

// Sol's re-check of #590 found the member breakdown still shipped one unchunked identity array.
// ClickHouse rejects a form field over 128 KiB, so 4,000 recipients with a mapped identifier each
// (about 260 KB of keys) failed with HTTP 500 while the headline, which already chunked, succeeded.
const BULK_RECIPIENTS = 4_000;

describe('a campaign too large for one identity field (#590)', () => {
  it('chunks the identity arrays, so 4,000 mapped recipients succeed and the rows agree', async () => {
    const broadcast = (
      await api().call('artifacts.create', {
        type: 'broadcast',
        name: 'Bulk broadcast',
        content: { template, segment },
      })
    ).artifactId;
    await api().call('artifacts.requestPublish', { artifactId: broadcast, note: 'bulk identity' });
    const campaign = await createCampaign('Bulk campaign', broadcast);
    await api().call('artifacts.requestPublish', { artifactId: campaign, note: 'bulk identity' });

    const first = 900_001;
    const last = first + BULK_RECIPIENTS - 1;
    const profile = (g: number) => `prf_${g.toString(16).padStart(32, '0')}`;
    await t.srv.db.admin.query(
      `INSERT INTO profiles (workspace_id, id)
       SELECT $1, 'prf_' || lpad(to_hex(g), 32, '0') FROM generate_series($2::int, $3::int) AS g ON CONFLICT DO NOTHING`,
      [ws, first, last],
    );
    await t.srv.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id)
       SELECT $1, 'user_id', 'bulk-user-' || g, 'prf_' || lpad(to_hex(g), 32, '0')
       FROM generate_series($2::int, $3::int) AS g ON CONFLICT DO NOTHING`,
      [ws, first, last],
    );
    const events: MessageEvent[] = Array.from({ length: BULK_RECIPIENTS }, (_, i) => {
      const g = first + i;
      return {
        workspaceId: ws,
        messageId: `msg_bulk_${g}`,
        eventId: `bulk:${g}:sent`,
        type: 'sent' as const,
        at: SEND_AT,
        profileId: profile(g),
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: template,
        templateVersion: 1,
        journeyId: broadcast,
        variant: '',
        reason: '',
        url: '',
      };
    });
    await t.srv.events.insertMessageEvents(events);
    clearAnalyticsCache();

    const summary = await api().call('analytics.campaignSummary', { campaignId: campaign, from: FROM, to: TO });
    expect(summary.state).toBe('measured');
    if (summary.state !== 'measured') return;
    expect(summary.headline.recipients).toBe(BULK_RECIPIENTS);
    expect(summary.headline.emailSent).toBe(BULK_RECIPIENTS);
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({ sent: BULK_RECIPIENTS, suppressed: false });
    expect(summary.members[0]!.sent).toBe(summary.headline.emailSent);
  }, 180_000);
});

describe('the campaign recipient scope (#590)', () => {
  it('skips resolution above the bound and reports the shared note on the summary and the holdout', async () => {
    // The production bound is the identity map's pair bound (300,000). A test bound keeps the
    // over-bound path fast without inserting that many rows.
    process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT = '3';
    try {
      clearAnalyticsCache();
      const summary = await api().call('analytics.campaignSummary', { campaignId: campaignB, from: FROM, to: TO });
      expect(summary.state).toBe('measured');
      if (summary.state !== 'measured') return;
      expect(summary.meta.notes.some((note) => note.includes('not identity-resolved'))).toBe(true);
      // The scope is skipped, not partially applied: stored profile ids still count.
      expect(summary.headline.recipients).toBe(5);
      expect(summary.members[0]).toMatchObject({ sent: 5, converters: 1, suppressed: false });

      // The campaign-wide holdout reads the same bound: ten people in each arm is above k, but the
      // twenty assignments are over the test scope, so it also ships no map and carries the note.
      const hash = holdoutHashVersion(50);
      const first = 910_001;
      const last = first + 9;
      await t.srv.db.admin.query(
        `INSERT INTO profiles (workspace_id, id)
         SELECT $1, 'prf_' || lpad(to_hex(g), 32, '0') FROM generate_series($2::int, $3::int) AS g ON CONFLICT DO NOTHING`,
        [ws, first, last],
      );
      const profile = (g: number) => `prf_${g.toString(16).padStart(32, '0')}`;
      const control = Array.from({ length: 5 }, (_, i) => profile(first + i));
      const treatment = Array.from({ length: 5 }, (_, i) => profile(first + 5 + i));
      await t.srv.db.admin.query(
        `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
         SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
        [ws, campaignC, hash, ASSIGNED_AT, control],
      );
      await t.srv.db.admin.query(
        `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
         SELECT $1, 'campaign', $2, $3, x, 'treatment', $4 FROM unnest($5::text[]) AS x`,
        [ws, campaignC, hash, ASSIGNED_AT, treatment],
      );

      const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignC });
      expect(holdout.control.entered).toBe(10);
      expect(holdout.treatment.entered).toBe(10);
      expect(holdout.suppressed).toBe(false);
      expect(holdout.note).toContain('not identity-resolved');
    } finally {
      delete process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT;
    }
  }, 60_000);
});

// Sol's round-3 re-check: the headline scoped the map to sent recipients while the campaign-wide
// holdout scoped it to its assignments, so near the bound only one side dropped resolution.
describe('one identity map for the headline, the member rows and the holdout (#590)', () => {
  it('drops resolution everywhere when the sent recipients and the assignments are jointly over the bound', async () => {
    // Sent recipients alone are under the test bound; the union with both holdout arms is over it.
    process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT = '10';
    try {
      const broadcast = (
        await api().call('artifacts.create', {
          type: 'broadcast',
          name: 'Union scope broadcast',
          content: { template, segment },
        })
      ).artifactId;
      await api().call('artifacts.requestPublish', { artifactId: broadcast, note: 'union scope' });
      const campaign = await createCampaign('Union scope campaign', broadcast);
      await api().call('artifacts.requestPublish', { artifactId: campaign, note: 'union scope' });

      // Six recipients keep the member row above k=5, while sent alone (6) stays under the bound.
      const recipients = Array.from({ length: 6 }, profileId);
      const controls = Array.from({ length: 5 }, profileId);
      const treatmentFillers = Array.from({ length: 4 }, profileId);
      await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [
        ws,
        [...recipients, ...controls, ...treatmentFillers],
      ]);
      await t.srv.events.insertMessageEvents(
        recipients.map(
          (profileId, i): MessageEvent => ({
            workspaceId: ws,
            messageId: `msg_union_${i}`,
            eventId: `union:${i}:sent`,
            type: 'sent',
            at: SEND_AT,
            profileId,
            channel: 'email',
            purpose: 'marketing_email',
            provider: 'log',
            templateId: template,
            templateVersion: 1,
            journeyId: broadcast,
            variant: '',
            reason: '',
            url: '',
          }),
        ),
      );
      // Five people in each arm keeps the holdout above k, so the note it carries is the map's,
      // not a suppression note. The treatment conversion is stored under the treatment profile, so
      // it is visible to every output even when resolution is dropped.
      await assign(controls, campaign, 'control');
      await assign([recipients[0]!, ...treatmentFillers], campaign, 'treatment');
      await t.srv.events.insert([conversion(recipients[0]!)]);
      clearAnalyticsCache();

      const summary = await api().call('analytics.campaignSummary', { campaignId: campaign, from: FROM, to: TO });
      expect(summary.state).toBe('measured');
      if (summary.state !== 'measured') return;
      expect(summary.meta.notes.some((note) => note.includes('not identity-resolved'))).toBe(true);
      expect(summary.headline.converters).toBe(1);
      expect(summary.members[0]).toMatchObject({ converters: 1, suppressed: false });

      const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaign, from: FROM, to: TO });
      expect(holdout.suppressed).toBe(false);
      expect(holdout.note).toContain('not identity-resolved');
      expect(holdout.control.converted).toBe(0);
      expect(holdout.treatment.converted).toBe(1);
      expect(summary.headline.converters).toBe(holdout.control.converted! + holdout.treatment.converted!);
    } finally {
      delete process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT;
    }
  }, 60_000);

  it('resolves a merged-away treatment conversion everywhere when the union is under the bound', async () => {
    // The inverse case: both parts are well under the bound, so every output uses the same map and
    // the treatment conversion stored under the merged-away profile resolves in all of them.
    process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT = '100';
    try {
      clearAnalyticsCache();
      const summary = await api().call('analytics.campaignSummary', { campaignId: campaignA, from: FROM, to: TO });
      expect(summary.state).toBe('measured');
      if (summary.state !== 'measured') return;
      expect(summary.meta.notes.some((note) => note.includes('not identity-resolved'))).toBe(false);
      expect(summary.headline.converters).toBe(1);
      expect(summary.members[0]).toMatchObject({ converters: 1, suppressed: false });

      const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignA, from: FROM, to: TO });
      expect(holdout.suppressed).toBe(false);
      expect(holdout.note).not.toContain('not identity-resolved');
      expect(holdout.treatment.converted).toBe(1);
      expect(summary.headline.converters).toBe(holdout.control.converted! + holdout.treatment.converted!);
    } finally {
      delete process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT;
    }
  }, 60_000);

  it('ignores holdout assignments outside the report window when deciding the bound (0.14.5 round 4)', async () => {
    // Assignments made before the window are not part of this report's holdout, so they must not
    // push the identity scope over the bound and change the window's numbers.
    process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT = '20';
    try {
      const old = Array.from({ length: 12 }, profileId);
      await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [ws, old]);
      await t.srv.db.admin.query(
        `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
         SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
        [ws, campaignA, holdoutHashVersion(50), '2026-03-01T00:00:00Z', old],
      );
      clearAnalyticsCache();
      const summary = await api().call('analytics.campaignSummary', { campaignId: campaignA, from: FROM, to: TO });
      expect(summary.state).toBe('measured');
      if (summary.state !== 'measured') return;
      expect(summary.meta.notes.some((note) => note.includes('not identity-resolved'))).toBe(false);
      expect(summary.headline.converters).toBe(1);
      const holdout = await api().call('campaigns.holdoutResult', { campaignId: campaignA, from: FROM, to: TO });
      expect(holdout.note).not.toContain('not identity-resolved');
      expect(holdout.treatment.converted).toBe(1);
    } finally {
      delete process.env.CAMPAIGN_IDENTITY_SCOPE_LIMIT;
    }
  }, 60_000);
});
