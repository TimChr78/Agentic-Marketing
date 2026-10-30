import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 16 (#65): a thin campaign object. It groups existing artifacts, refuses ambiguous
// attribution for sending members, and gives their e-mails a shared utm_campaign. No campaign
// engine: the members keep sending exactly as before.

const PORT = testPort(3473);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let segmentId = '';
const stamp = Date.now();

const api = () => t.api(owner, ws);

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

/** An e-mail issue with an outbound link, so UTM tagging has something to tag. */
const issue = (subject: string, body: string, utm?: object) => ({
  purpose: 'marketing_email',
  subject,
  mjml: mjml(`${body} <a href="https://shop.example.com/tools?a=1">Read the guide</a>`),
  ...(utm ? { utm } : {}),
});

const create = async (type: 'email_template' | 'broadcast' | 'campaign' | 'segment', name: string, content: object) =>
  (await api().call('artifacts.create', { type, name, content })).artifactId;

const campaign = (name: string, members: { artifactId: string; role?: 'primary' | 'follow_up' | 'content' }[], extra: object = {}) =>
  create('campaign', name, { goal: { kind: 'engagement', attributionDays: 7 }, members, ...extra });

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

/**
 * The URLs behind the HTML's click-tracking links. Click tracking wraps every link in a signed
 * token, so the UTM tags are inside the token rather than visible as a query string in the HTML.
 */
const trackedTargets = (html: string) =>
  [...html.matchAll(/href="([^"]*\/c\/[^"]+)"/g)].map(([, href]) => {
    const token = href.split('/c/')[1]!.split('.')[0]!;
    return (JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { url: string }).url;
  });

/** A person with a marketing-e-mail consent record, ready for the segment. */
async function person(userId: string, email: string) {
  const res = await ingest([
    { type: 'identify', userId, traits: { email, firstName: userId } },
    {
      type: 'track',
      event: 'Segment Consent Preference Updated',
      userId,
      timestamp: '2026-10-21T08:00:01Z',
      context: { consent: { categoryPreferences: { marketing_email: true } } },
    },
  ]);
  expect(res.status).toBe(200);
  const { profileId } = await eventually(
    () => api().call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api().call('profiles.get', { profileId: profileId! }),
    (p) => p.consent.length > 0,
  );
  return profileId!;
}

beforeAll(async () => {
  t = await startTestServer('test_campaigns', PORT);
  owner = await t.signUp(`owner-campaigns-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await person('u-ada', `ada-${stamp}@example.com`);
  await person('u-bo', `bo-${stamp}@example.com`);
  segmentId = await create('segment', 'Subscribers', { condition: { consent: 'marketing_email' } });
  await api().call('artifacts.requestPublish', { artifactId: segmentId, note: 'audience' });
  await eventually(
    async () =>
      (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM segment_memberships WHERE segment_id = $1', [segmentId]))
        .rows[0]!.n,
    (n) => n >= 2,
  );
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('campaigns', () => {
  let template = '';
  let broadcast = '';
  let launch = '';

  it('creates and publishes a campaign with its members in one bundle', async () => {
    template = await create('email_template', 'Launch issue', issue('Launch issue', 'The launch is here.'));
    broadcast = await create('broadcast', 'Launch send', { template, segment: segmentId });
    launch = await campaign(
      'Launch A',
      [
        { artifactId: broadcast, role: 'primary' },
        { artifactId: template, role: 'content' },
        { artifactId: segmentId, role: 'content' },
      ],
      { goal: { kind: 'signups', target: 100, attributionDays: 14 }, utmCampaign: 'launch-a' },
    );

    const r = await api().call('artifacts.requestPublishBundle', { artifactIds: [launch, broadcast, template], note: 'launch' });
    expect(r.status).toBe('published');
    expect(r.members.map((m) => m.artifactId)).toEqual([template, broadcast, launch]);
    expect((await api().call('artifacts.get', { artifactId: launch })).publishedVersion).toBe(1);

    const members = await api().call('campaigns.members', { campaignId: launch });
    expect(members).toMatchObject({ campaignId: launch, version: 1, published: true });
    expect(members.members.map((m) => m.artifactId).sort()).toEqual([broadcast, segmentId, template].sort());
    expect(members.members.find((m) => m.artifactId === broadcast)).toMatchObject({
      type: 'broadcast',
      role: 'primary',
      status: 'published',
    });

    const of = await api().call('campaigns.of', { artifactId: broadcast });
    expect(of.campaigns).toEqual([
      {
        id: launch,
        name: 'Launch A',
        role: 'primary',
        goal: { kind: 'signups', event: null, target: 100, attributionDays: 14 },
        utmCampaign: 'launch-a',
      },
    ]);
    expect((await api().call('campaigns.of', { artifactId: template })).campaigns.map((c) => c.id)).toContain(launch);
  });

  it('refuses a sending member that already belongs to another published campaign, and names it', async () => {
    const dup = await campaign('Launch B', [{ artifactId: broadcast, role: 'primary' }]);
    const err = await rejects(api().call('artifacts.requestPublish', { artifactId: dup, note: 'duplicate' }));
    expect(err.message).toMatch(/already belongs to the published campaign/);
    expect(err.message).toContain('Launch A');
    expect(err.message).toContain(broadcast);

    const missing = await campaign('Ghost', [{ artifactId: `bct_${'0'.repeat(32)}`, role: 'primary' }]);
    const gone = await rejects(api().call('artifacts.requestPublish', { artifactId: missing, note: 'missing member' }));
    expect(gone.message).toMatch(/does not exist in this workspace/);
  });

  it('allows republishing the same campaign with the same sending member', async () => {
    const current = (await api().call('artifacts.get', { artifactId: launch })).version.content as Record<string, unknown>;
    await api().call('artifacts.updateDraft', { artifactId: launch, content: { ...current, description: 'Updated goal' } });
    const r = await api().call('artifacts.requestPublish', { artifactId: launch, note: 'same members' });
    expect(r.status).toBe('published');
    expect((await api().call('artifacts.get', { artifactId: launch })).publishedVersion).toBe(2);
  });

  it('lets two published campaigns share a template', async () => {
    const shared = await create('email_template', 'Shared block of content', issue('Shared content', 'Reused everywhere.'));
    const a = await campaign('Shared A', [{ artifactId: shared, role: 'content' }]);
    const b = await campaign('Shared B', [{ artifactId: shared, role: 'content' }]);
    await api().call('artifacts.requestPublish', { artifactId: a, note: 'shared a' });
    await api().call('artifacts.requestPublish', { artifactId: b, note: 'shared b' });
    const of = await api().call('campaigns.of', { artifactId: shared });
    expect(of.campaigns.map((c) => c.id).sort()).toEqual([a, b].sort());
  });

  it('inherits the campaign utm_campaign in the sent e-mail, unless the template sets one', async () => {
    const inheritedTpl = await create(
      'email_template',
      'Inherited UTM',
      issue('Inherited UTM', 'Inherits the campaign.', { source: 'newsletter', medium: 'email' }),
    );
    const inheritedSend = await create('broadcast', 'Inherited UTM send', { template: inheritedTpl, segment: segmentId });
    const inheritedCampaign = await campaign(
      'UTM launch',
      [
        { artifactId: inheritedSend, role: 'primary' },
        { artifactId: inheritedTpl, role: 'content' },
      ],
      { utmCampaign: 'launch-utm' },
    );
    const published = await api().call('artifacts.requestPublishBundle', {
      artifactIds: [inheritedTpl, inheritedSend, inheritedCampaign],
      note: 'utm inheritance',
    });
    expect(published.status).toBe('published');

    const mail = await eventually(
      async () => outbox.find((m) => m.subject === 'Inherited UTM'),
      (m) => !!m,
    );
    expect(mail?.html).toBeTruthy();
    const inheritedTargets = trackedTargets(mail!.html);
    expect(inheritedTargets.some((url) => url.includes('utm_campaign=launch-utm'))).toBe(true);
    expect(mail?.text).toContain('utm_campaign=launch-utm');

    const ownTpl = await create(
      'email_template',
      'Own UTM',
      issue('Own UTM', 'Sets its own campaign.', { source: 'newsletter', medium: 'email', campaign: 'own-campaign' }),
    );
    const ownSend = await create('broadcast', 'Own UTM send', { template: ownTpl, segment: segmentId });
    const ownCampaign = await campaign(
      'UTM launch other',
      [
        { artifactId: ownSend, role: 'primary' },
        { artifactId: ownTpl, role: 'content' },
      ],
      { utmCampaign: 'campaign-other' },
    );
    await api().call('artifacts.requestPublishBundle', { artifactIds: [ownTpl, ownSend, ownCampaign], note: 'template wins' });

    const own = await eventually(
      async () => outbox.find((m) => m.subject === 'Own UTM'),
      (m) => !!m,
    );
    expect(own).toBeTruthy();
    const ownTargets = trackedTargets(own!.html);
    expect(ownTargets.some((url) => url.includes('utm_campaign=own-campaign'))).toBe(true);
    expect(ownTargets.every((url) => !url.includes('utm_campaign=campaign-other'))).toBe(true);
    expect(own?.text).toContain('utm_campaign=own-campaign');
    expect(own?.text).not.toContain('utm_campaign=campaign-other');
  });

  it('archives a campaign without touching its members', async () => {
    const members = await api().call('campaigns.members', { campaignId: launch });
    const ids = members.members.map((m) => m.artifactId);
    const archived = await api().call('campaigns.archive', { campaignId: launch });
    expect(archived).toMatchObject({ campaignId: launch, archived: true });
    expect(archived.memberIds.sort()).toEqual(ids.sort());

    for (const id of ids) {
      const a = await api().call('artifacts.get', { artifactId: id });
      expect(a.publishedVersion).not.toBeNull();
    }
    const rows = await t.srv.db.admin.query<{ id: string; archived: boolean }>(
      'SELECT id, archived FROM artifacts WHERE workspace_id = $1 AND id = ANY($2)',
      [ws, ids],
    );
    expect(rows.rows.every((r) => r.archived === false)).toBe(true);
    const camp = await t.srv.db.admin.query<{ archived: boolean }>('SELECT archived FROM artifacts WHERE workspace_id = $1 AND id = $2', [
      ws,
      launch,
    ]);
    expect(camp.rows[0]!.archived).toBe(true);

    // An archived campaign is no longer live for lookups or shared UTM.
    expect((await api().call('campaigns.of', { artifactId: broadcast })).campaigns).toEqual([]);
    expect((await api().call('campaigns.members', { campaignId: launch })).members).toHaveLength(ids.length);
  });
});
