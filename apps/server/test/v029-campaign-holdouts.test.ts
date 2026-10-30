import { outbox } from '@agentic-marketing/email';
import { armFor, holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// v0.2.9 (#67): campaign control groups. One deterministic arm per person for the whole campaign;
// every sending member inherits it, control gets no message from any of them, and the result is
// measured once for the campaign with lift, a Newcombe interval and revenue per currency.

const PORT = testPort(3481);
const DB = 'test_v029_campaign_holdouts';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let template = '';
let segment = '';
let campaignId = '';
let broadcastId = '';
let journeyId = '';
let control: { userId: string; profileId: string; email: string } | null = null;
let treatment: { userId: string; profileId: string; email: string } | null = null;

const stamp = Date.now();
const api = () => t.api(owner, ws);

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const create = async (type: string, name: string, content: object) =>
  (await api().call('artifacts.create', { type: type as never, name, content })).artifactId;

const createPublished = async (type: string, name: string, content: object) => {
  const id = await create(type, name, content);
  await api().call('artifacts.requestPublish', { artifactId: id, note: 'campaign holdout test' });
  return id;
};

const profilesByPrefix = async (prefix: string) =>
  (
    await t.srv.db.admin.query<{ value: string; profile_id: string }>(
      `SELECT i.value, i.profile_id FROM identifiers i
       WHERE i.workspace_id = $1 AND i.type = 'user_id' AND i.value LIKE $2`,
      [ws, `${prefix}%`],
    )
  ).rows;

const assignmentsOf = async (id: string) =>
  (
    await t.srv.db.admin.query<{ profile_id: string; arm: string; hash_version: string }>(
      `SELECT profile_id, arm, hash_version FROM holdout_assignments
       WHERE workspace_id = $1 AND scope_type = 'campaign' AND scope_id = $2`,
      [ws, id],
    )
  ).rows;

const assignmentCount = async (id: string) =>
  (
    await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM holdout_assignments WHERE workspace_id = $1 AND scope_type = 'campaign' AND scope_id = $2`,
      [ws, id],
    )
  ).rows[0]!.n;

interface MessageRow {
  id: string;
  profile_id: string;
  status: string;
  reason: string | null;
}
const messagesOf = async (id: string) =>
  (
    await t.srv.db.admin.query<MessageRow>(
      `SELECT id::text, profile_id, status, reason FROM messages WHERE workspace_id = $1 AND journey_id = $2`,
      [ws, id],
    )
  ).rows;

interface ParticipantRow {
  id: string;
  status: string;
  node: string;
  context: { holdout?: { arm: string; campaignId?: string; hashVersion: string; percent: number } };
}
const participantOf = async (jid: string, profileId: string) =>
  (
    await t.srv.db.admin.query<ParticipantRow>(
      `SELECT id::text, status, node, context FROM journey_participants
       WHERE journey_id = $1 AND profile_id = $2 ORDER BY id DESC LIMIT 1`,
      [jid, profileId],
    )
  ).rows[0];

const holdoutEventsOf = async (id: string) => {
  const settings = await t.srv.events.settingsFor(ws);
  const rs = await t.srv.events.client.query({
    query: `SELECT profile_id, detail FROM journey_events FINAL
            WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND type = 'holdout_assigned'`,
    query_params: { ws, j: id },
    format: 'JSONEachRow',
    clickhouse_settings: settings as never,
  });
  return rs.json<{ profile_id: string; detail: string }>();
};

/** A campaign whose members are a broadcast and a journey, both published with it. */
async function sendCampaign() {
  journeyId = await create('journey', 'Campaign journey', {
    purpose: 'marketing_email',
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Campaign Start', reentry: 'once' } },
      { id: 'email', kind: 'email', label: 'Journey mail', config: { template }, next: [{ to: 'done' }] },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ],
  });
  broadcastId = await create('broadcast', 'Campaign broadcast', { template, segment });
  campaignId = await create('campaign', 'Full campaign', {
    description: 'Control covers both sends',
    goal: { kind: 'conversion', event: 'Campaign Purchase', attributionDays: 7 },
    controlGroup: { percent: 50, minSampleSize: 200 },
    members: [
      { artifactId: broadcastId, role: 'primary' },
      { artifactId: journeyId, role: 'follow_up' },
      { artifactId: template, role: 'content' },
      { artifactId: segment, role: 'content' },
    ],
  });
  const published = await api().call('artifacts.requestPublishBundle', {
    artifactIds: [broadcastId, journeyId, campaignId],
    note: 'campaign with a control group',
  });
  expect(published.status).toBe('published');
}

async function preparePeople(prefix: string, count: number, consent: boolean) {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  await ingest(ids.map((userId) => ({ type: 'identify', userId, traits: { email: `${userId}-${stamp}@example.com` } })));
  const rows = await eventually(
    () => profilesByPrefix(prefix),
    (r) => r.length === count,
    20_000,
  );
  if (consent)
    for (const row of rows)
      await api().call('consent.record', { profileId: row.profile_id, purpose: 'marketing_email', status: 'granted' });
  return rows.map((r) => ({ userId: r.value, profileId: r.profile_id, email: `${r.value}-${stamp}@example.com` }));
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-campaign-holdouts-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  template = await createPublished('email_template', 'Campaign mail', {
    purpose: 'marketing_email',
    subject: 'Campaign news',
    mjml: mjml('The campaign is here.'),
  });
  await preparePeople('arm-', 16, true);
  segment = await create('segment', 'Campaign subscribers', { condition: { consent: 'marketing_email' } });
  await api().call('artifacts.requestPublish', { artifactId: segment, note: 'audience' });
  await eventually(
    async () => (await api().call('segments.members', { artifactId: segment })).members.length,
    (n) => n === 16,
    20_000,
  );
  await sendCampaign();
}, 120_000);

afterAll(() => t?.close());

describe('campaign control group', () => {
  it('assigns one deterministic arm per person across both sending members', async () => {
    const people = await profilesByPrefix('arm-');
    expect(people).toHaveLength(16);
    await eventually(
      () => messagesOf(broadcastId),
      (rows) => rows.length === 16,
      20_000,
    );
    const hash = holdoutHashVersion(50);
    const stored = await assignmentsOf(campaignId);
    expect(stored).toHaveLength(16);
    for (const row of people) {
      const expected = armFor(50, ws, campaignId, hash, row.profile_id);
      expect(stored.find((s) => s.profile_id === row.profile_id)).toMatchObject({ arm: expected, hash_version: hash });
    }
    // The journey entry reads the campaign's arm instead of randomising again.
    const personWithArm = (arm: 'control' | 'treatment') => {
      const row = stored.find((s) => s.arm === arm);
      if (!row) return null;
      const p = people.find((x) => x.profile_id === row.profile_id)!;
      return { userId: p.value, profileId: p.profile_id, email: `${p.value}-${stamp}@example.com` };
    };
    control = personWithArm('control');
    treatment = personWithArm('treatment');
    expect(control).not.toBeNull();
    expect(treatment).not.toBeNull();
    expect(await assignmentCount(campaignId)).toBe(16);
  });

  it('sends to treatment and suppresses control in the broadcast, then does the same in the journey', async () => {
    expect(control && treatment).toBeTruthy();
    const hash = holdoutHashVersion(50);
    const expected = armFor(50, ws, campaignId, hash, control!.profileId);
    expect(expected).toBe('control');

    const rows = await messagesOf(broadcastId);
    const controlMessage = rows.find((r) => r.profile_id === control!.profileId);
    expect(controlMessage).toMatchObject({ status: 'suppressed' });
    expect(controlMessage?.reason).toContain('holdout_control');
    expect(rows.find((r) => r.profile_id === treatment!.profileId)?.status).not.toBe('suppressed');
    await eventually(
      () => Promise.resolve(outbox.filter((m) => m.to === treatment!.email)),
      (mails) => mails.length === 1,
      20_000,
    );
    expect(outbox.filter((m) => m.to === control!.email)).toHaveLength(0);

    await ingest([
      { type: 'track', event: 'Campaign Start', userId: control!.userId },
      { type: 'track', event: 'Campaign Start', userId: treatment!.userId },
    ]);
    const controlParticipant = await eventually(
      () => participantOf(journeyId, control!.profileId),
      (p) => !!p,
      20_000,
    );
    expect(controlParticipant?.context.holdout).toMatchObject({ arm: 'control', percent: 50, hashVersion: hash, campaignId });
    await eventually(
      () => participantOf(journeyId, treatment!.profileId),
      (p) => !!p,
      20_000,
    );
    expect(await messagesOf(journeyId).then((all) => all.filter((m) => m.profile_id === control!.profileId))).toHaveLength(0);
    await eventually(
      () => Promise.resolve(outbox.filter((m) => m.to === treatment!.email)),
      (mails) => mails.length === 2,
      20_000,
    );
    expect(outbox.filter((m) => m.to === control!.email)).toHaveLength(0);

    // Still one assignment per person after the second member touched them.
    expect(await assignmentCount(campaignId)).toBe(16);
    const events = await holdoutEventsOf(campaignId);
    for (const person of [control!, treatment!]) {
      const mine = events.filter((e) => e.profile_id === person.profileId);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.detail).toContain(`campaignId=${campaignId}`);
    }

    // Two arms of eight cannot meet the default minimum of 200.
    const result = await api().call('campaigns.holdoutResult', { campaignId });
    expect(result.minSampleSizeMet).toBe(false);
    expect(result.verdict).toBe('not_enough_data');
    expect(result.goal).toMatchObject({ kind: 'conversion', event: 'Campaign Purchase', attributionDays: 7 });
    expect(result.control.entered + result.treatment.entered).toBe(16);
    expect(result.control.revenue).toEqual({});
  });
});

describe('campaign result statistics', () => {
  it('counts goal events inside the attribution window and reports revenue per currency', async () => {
    await createPublished('conversion_map', 'Revenue map', {
      rules: [
        {
          event: 'Campaign Revenue',
          value: 'order.total',
          currencyProperty: 'order.currency',
          meta: {
            connection: (
              await api().call('connections.create', {
                connector: 'meta_ads',
                name: 'Meta test',
                settings: { pixelId: '1234567890' },
                secrets: { accessToken: 'test-access-token-1234567890' },
              })
            ).id,
            eventName: 'Purchase',
          },
        },
      ],
    });
    const measurementJourney = await createPublished('journey', 'Measurement member', {
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Never Fires', reentry: 'once' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const id = await create('campaign', 'Measured campaign', {
      goal: { kind: 'revenue', event: 'Campaign Revenue', attributionDays: 7 },
      controlGroup: { percent: 50, minSampleSize: 100 },
      members: [{ artifactId: measurementJourney, role: 'primary' }],
    });
    await api().call('artifacts.requestPublish', { artifactId: id, note: 'measure' });

    const people = await preparePeople('measured-', 200, false);
    const hash = holdoutHashVersion(50);
    const assignedAt = new Date(Date.now() - 2 * 86_400_000);
    const controlPeople = people.slice(0, 100);
    const treatmentPeople = people.slice(100);
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
       SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
      [ws, id, hash, assignedAt, controlPeople.map((p) => p.profileId)],
    );
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
       SELECT $1, 'campaign', $2, $3, x, 'treatment', $4 FROM unnest($5::text[]) AS x`,
      [ws, id, hash, assignedAt, treatmentPeople.map((p) => p.profileId)],
    );

    let n = 0;
    const event = (userId: string, at: Date, total: number, currency: string) => ({
      workspaceId: ws,
      sourceId: 'src_campaign_holdouts',
      messageId: `evt-campaign-${n++}`,
      type: 'track' as const,
      name: 'Campaign Revenue',
      anonymousId: '',
      userId,
      timestamp: at.toISOString(),
      receivedAt: at.toISOString(),
      properties: { order: { total, currency } },
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    });
    const inside = new Date(assignedAt.getTime() + 86_400_000);
    const outside = new Date(assignedAt.getTime() + 8 * 86_400_000);
    const before = new Date(assignedAt.getTime() - 3_600_000);
    await t.srv.events.insert([
      ...controlPeople.slice(0, 10).map((p) => event(p.userId, inside, 10, 'USD')),
      ...treatmentPeople.slice(0, 30).map((p) => event(p.userId, inside, 20, 'EUR')),
      // Outside the 7-day window, or before the assignment: events that must not count.
      ...controlPeople.slice(10, 25).map((p) => event(p.userId, outside, 99, 'USD')),
      ...treatmentPeople.slice(30, 45).map((p) => event(p.userId, before, 99, 'EUR')),
    ]);
    await t.srv.events.insertMessageEvents(
      treatmentPeople.slice(30, 35).map((p, i) => ({
        workspaceId: ws,
        messageId: `msg-campaign-unsub-${i}`,
        eventId: `evt-campaign-unsub-${i}`,
        type: 'unsubscribed' as const,
        at: new Date().toISOString(),
        profileId: p.profileId,
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: template,
        templateVersion: 1,
        journeyId: measurementJourney,
        reason: '',
        url: '',
      })),
    );

    const result = await api().call('campaigns.holdoutResult', { campaignId: id });
    expect(result.control).toMatchObject({ entered: 100, converted: 10, unsubscribed: 0, revenue: { USD: 100 } });
    expect(result.treatment).toMatchObject({ entered: 100, converted: 30, unsubscribed: 5, revenue: { EUR: 600 } });
    expect(result.control.conversionRate).toBeCloseTo(0.1, 10);
    expect(result.treatment.conversionRate).toBeCloseTo(0.3, 10);
    expect(result.treatment.unsubscribeRate).toBeCloseTo(0.05, 10);
    expect(result.absoluteLift).toBeCloseTo(0.2, 10);
    expect(result.relativeLift).toBeCloseTo(2, 10);
    expect(result.ci95![0]).toBeCloseTo(0.0900021, 6);
    expect(result.ci95![1]).toBeCloseTo(0.3057893, 6);
    expect(result.minSampleSizeMet).toBe(true);
    expect(result.verdict).toBe('treatment_better');
    expect(result.controlGroup).toMatchObject({ percent: 50, minSampleSize: 100, hashVersion: hash });
  }, 120_000);
});

describe('one scope only', () => {
  it('refuses a campaign whose journey member defines its own control group', async () => {
    const ownJourney = await createPublished('journey', 'Own control journey', {
      purpose: 'marketing_email',
      controlGroup: { percent: 10 },
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Own Nested', reentry: 'once' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const id = await create('campaign', 'Nested campaign A', {
      goal: { kind: 'conversion', event: 'Nested Goal', attributionDays: 7 },
      controlGroup: { percent: 10 },
      members: [{ artifactId: ownJourney, role: 'primary' }],
    });
    const refused = await rejects(api().call('artifacts.requestPublish', { artifactId: id, note: 'nested' }));
    expect(refused.message).toContain('only one scope');
  });

  it('refuses a journey that adds its own control group while in a campaign with one', async () => {
    const nestedJourney = await createPublished('journey', 'Campaign member journey', {
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Nested B', reentry: 'once' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const id = await create('campaign', 'Nested campaign B', {
      goal: { kind: 'conversion', event: 'Nested Goal', attributionDays: 7 },
      controlGroup: { percent: 10 },
      members: [{ artifactId: nestedJourney, role: 'primary' }],
    });
    await api().call('artifacts.requestPublish', { artifactId: id, note: 'campaign first' });

    const got = await api().call('artifacts.get', { artifactId: nestedJourney });
    const content = got.version.content as { controlGroup?: object };
    await api().call('artifacts.updateDraft', {
      artifactId: nestedJourney,
      content: { ...content, controlGroup: { percent: 10 } } as never,
    });
    const refused = await rejects(api().call('artifacts.requestPublish', { artifactId: nestedJourney, note: 'add own control' }));
    expect(refused.message).toContain('published campaign');
    expect(refused.message).toContain('only one scope');
  });
});

describe('scope changes and erasure', () => {
  it('refuses a changed percentage after assignments, and allows it with reset', async () => {
    const id = await create('campaign', 'Scope campaign', {
      goal: { kind: 'conversion', event: 'Scope Goal', attributionDays: 7 },
      controlGroup: { percent: 10 },
    });
    await api().call('artifacts.requestPublish', { artifactId: id, note: 'scope' });
    const person = (await profilesByPrefix('arm-'))[0]!;
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       VALUES ($1, 'campaign', $2, $3, $4, 'control')`,
      [ws, id, holdoutHashVersion(10), person.profile_id],
    );

    const got = await api().call('artifacts.get', { artifactId: id });
    const content = got.version.content as { controlGroup: { percent: number; minSampleSize: number; reset?: boolean } };
    await api().call('artifacts.updateDraft', {
      artifactId: id,
      content: { ...content, controlGroup: { ...content.controlGroup, percent: 20 } } as never,
    });
    const refused = await rejects(api().call('artifacts.requestPublish', { artifactId: id, note: 'widen' }));
    expect(refused.message).toContain('controlGroup.reset: true');

    await api().call('artifacts.updateDraft', {
      artifactId: id,
      content: { ...content, controlGroup: { ...content.controlGroup, percent: 20, reset: true } } as never,
    });
    const published = await api().call('artifacts.requestPublish', { artifactId: id, note: 'widen with reset' });
    expect(published.status).toBe('published');
  });

  it('removes the campaign assignment when a profile is erased', async () => {
    expect(control).not.toBeNull();
    await api().call('profiles.erase', { profileId: control!.profileId, reason: 'test erasure' });
    expect((await assignmentsOf(campaignId)).some((a) => a.profile_id === control!.profileId)).toBe(false);
    expect(await assignmentCount(campaignId)).toBe(15);
  });
});
