import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, rejects, startTestServer, testPort, type User } from './harness';

// Phase 20 (#64): the campaign agent. An agent drafts a typed campaign_brief; a person approves
// it; campaigns.plan maps the approved brief to deterministic artifact skeletons and
// campaigns.fromBrief creates the drafts with resolved references. Nothing is published by the
// agent, and a person still approves the bundle.

const PORT = testPort(2611);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;
let segmentId = '';
let briefId = '';
let built: any;
const stamp = Date.now();

const api = () => t.api(owner);
const mcp = async (name: string, args: unknown = {}) =>
  (await agent.client.callTool({ name, arguments: args as Record<string, unknown> })) as any;

const sendAt = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

const brief = (extra: Record<string, unknown> = {}) => ({
  objective: 'Win back people who bought once and stopped opening the newsletter',
  goal: {
    measure: 'campaign.conversion_rate',
    kind: 'conversion',
    event: 'Order Completed',
    target: 2,
    direction: 'up',
    attributionDays: 14,
  },
  audience: {
    description: 'One-time buyers from the last 12 months who consented to marketing e-mail',
    segmentIds: [segmentId],
  },
  message: { key: 'Your next order is 15% off', tone: 'warm', language: 'en' },
  offer: { description: '15% off the next order', source: 'voucher pool vip-2026' },
  channels: [{ channel: 'email' }],
  schedule: { mode: 'once', sendAt: sendAt() },
  guardrails: { unsubscribeRate: 0.005 },
  successCriteria: ['2% of the treatment arm orders within 14 days', 'Unsubscribe rate stays under 0.5%'],
  holdout: { percent: 10, minSampleSize: 200 },
  assumptions: ['The audience allows marketing e-mail'],
  ...extra,
});

beforeAll(async () => {
  t = await startTestServer('test_campaign_agent', PORT);
  owner = await t.signUp(`owner-campaign-agent-${stamp}@example.com`);
  // agent_changes: the agent's publish request waits for a person, so approval is testable.
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
  segmentId = (
    await api().call('artifacts.create', {
      type: 'segment',
      name: 'Lapsed buyers',
      content: { description: 'People who allow marketing e-mail', condition: { consent: 'marketing_email' } },
    })
  ).artifactId;
  // A person's own draft under agent_changes publishes directly when requested.
  const published = await api().call('artifacts.requestPublish', { artifactId: segmentId, note: 'audience' });
  expect(published.status).toBe('published');
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('campaign agent (#64)', () => {
  it('lets an agent draft a brief but not publish it, and refuses a plan before approval', async () => {
    const created = await mcp('artifacts.create', {
      type: 'campaign_brief',
      name: 'Win-back November',
      content: brief(),
    });
    expect(created.isError).toBeFalsy();
    briefId = created.structuredContent.artifactId;
    expect(briefId).toMatch(/^cpb_[0-9a-f]{32}$/);
    expect(created.structuredContent.state).toBe('draft');

    const submitted = await mcp('artifacts.requestPublish', { artifactId: briefId, note: 'Brief for the win-back campaign' });
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent.status).toBe('in_review');
    expect(submitted.structuredContent.approvalId).toMatch(/^apr_/);

    // The agent cannot approve its own brief; approval is not an MCP tool for agents.
    await expect(mcp('approvals.approve', { approvalId: submitted.structuredContent.approvalId })).rejects.toThrow(/not found/i);

    const beforeApproval = await api().call('artifacts.get', { artifactId: briefId });
    expect(beforeApproval.publishedVersion).toBeNull();
    await expect(api().call('campaigns.plan', { briefId })).rejects.toThrow(/no published version/i);
    await expect(api().call('campaigns.fromBrief', { briefId })).rejects.toThrow(/no published version/i);

    // A person approves: the brief is the contract the plan is built from.
    const approved = await api().call('approvals.approve', { approvalId: submitted.structuredContent.approvalId });
    expect(approved).toMatchObject({ status: 'approved', artifactId: briefId, version: 1 });
    expect((await api().call('artifacts.get', { artifactId: briefId })).publishedVersion).toBe(1);
  });

  it('plans a deterministic bundle with the control group the brief asks for', async () => {
    const plan = await api().call('campaigns.plan', { briefId });
    expect(plan).toMatchObject({
      briefId,
      briefVersion: 1,
      name: 'Win-back November',
      goal: { measure: 'campaign.conversion_rate', kind: 'conversion', event: 'Order Completed', target: 2, attributionDays: 14 },
      holdout: { percent: 10, minSampleSize: 200 },
    });
    // One named segment is used as-is: no segment draft.
    expect(plan.drafts.map((draft: { type: string }) => draft.type)).toEqual(['email_template', 'broadcast', 'campaign']);
    const campaign = plan.drafts.find((draft: { key: string }) => draft.key === 'campaign')!;
    const campaignContent = campaign.content as any;
    expect(campaignContent).toMatchObject({
      briefId,
      briefVersion: 1,
      goal: { kind: 'conversion', event: 'Order Completed', target: 2, attributionDays: 14 },
      controlGroup: { percent: 10, minSampleSize: 200 },
      utmCampaign: 'win-back-november',
    });
    expect(campaignContent.members).toEqual([
      { artifactId: '@draft:email_template', role: 'content' },
      { artifactId: segmentId, role: 'content' },
      { artifactId: '@draft:broadcast', role: 'primary' },
    ]);
    // The deterministic mapping says where it stops being meaningful.
    expect(plan.notes.join(' ')).toMatch(/Offer/);
    expect(plan.notes.join(' ')).toMatch(/Guardrails/);
    expect(plan.notes.join(' ')).toMatch(/does not write the final copy/);
    expect(plan.warnings).toEqual([]);

    // A plan writes nothing.
    const listed = await api().call('artifacts.list', { type: 'campaign' });
    expect(listed.artifacts).toEqual([]);
  });

  it('creates the drafts with resolved references and publishes nothing', async () => {
    const response = await mcp('campaigns.fromBrief', { briefId });
    expect(response.isError).toBeFalsy();
    built = response.structuredContent;
    expect(built).toMatchObject({ briefId, briefVersion: 1 });
    expect(built.campaignId).toMatch(/^cmp_[0-9a-f]{32}$/);
    const byKey = Object.fromEntries(built.artifacts.map((item: { key: string }) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['broadcast', 'campaign', 'email_template']);
    for (const item of built.artifacts) {
      expect(item.state).toBe('draft');
      expect((await api().call('artifacts.get', { artifactId: item.artifactId })).publishedVersion).toBeNull();
    }

    const template = await api().call('artifacts.get', { artifactId: byKey.email_template.artifactId });
    expect(template.version.content).toMatchObject({ purpose: 'marketing_email', subject: 'Your next order is 15% off' });

    const broadcast = await api().call('artifacts.get', { artifactId: byKey.broadcast.artifactId });
    expect(broadcast.version.content).toMatchObject({ template: byKey.email_template.artifactId, segment: segmentId });

    const campaign = await api().call('artifacts.get', { artifactId: built.campaignId });
    expect(campaign.version.content).toMatchObject({
      briefId,
      briefVersion: 1,
      controlGroup: { percent: 10, minSampleSize: 200 },
      members: [
        { artifactId: byKey.email_template.artifactId, role: 'content' },
        { artifactId: segmentId, role: 'content' },
        { artifactId: byKey.broadcast.artifactId, role: 'primary' },
      ],
    });
  });

  it('passes publish validation when a person submits the drafts as one bundle', async () => {
    const ids = built.artifacts.map((item: { artifactId: string }) => item.artifactId);
    const bundle = await api().call('artifacts.requestPublishBundle', {
      artifactIds: ids,
      note: 'Win-back campaign built from the approved brief',
    });
    // The drafts are agent-authored, so even a person's submission waits for an approval under agent_changes.
    expect(bundle.status).toBe('in_review');
    expect(bundle.members.map((member: { type: string }) => member.type)).toEqual(['email_template', 'broadcast', 'campaign']);

    const approvalId = bundle.members.find((member: { type: string }) => member.type === 'campaign')!.approvalId!;
    const approved = await api().call('approvals.approve', { approvalId });
    expect(approved.status).toBe('approved');
    for (const id of ids) expect((await api().call('artifacts.get', { artifactId: id })).publishedVersion).toBe(1);
    const campaign = await api().call('artifacts.get', { artifactId: built.campaignId });
    expect(campaign.publishedVersion).toBe(1);
  });

  it('creates a segment and a journey when the brief names no audience and several channels', async () => {
    const created = await api().call('artifacts.create', {
      type: 'campaign_brief',
      name: 'Onboarding nudge',
      content: brief({
        goal: { measure: 'email.click_rate', kind: 'engagement', event: 'Signed Up', target: 6, direction: 'up', attributionDays: 7 },
        audience: { description: 'New signups who have not opened the welcome mail', segmentIds: [] },
        channels: [{ channel: 'email' }, { channel: 'sms' }],
        schedule: { mode: 'journey', waitBetweenSteps: 'P2D' },
        holdout: { percent: 5 },
        offer: undefined,
      }),
    });
    await api().call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Onboarding brief' });
    const plan = await api().call('campaigns.plan', { briefId: created.artifactId });
    expect(plan.drafts.map((draft: { type: string }) => draft.type)).toEqual([
      'segment',
      'email_template',
      'sms_template',
      'journey',
      'campaign',
    ]);
    expect(plan.warnings.join(' ')).toMatch(/placeholder/);
    const journey = plan.drafts.find((draft: { key: string }) => draft.key === 'journey')!;
    expect((journey.content as any).nodes.map((node: { kind: string }) => node.kind)).toEqual(['trigger', 'email', 'wait', 'sms', 'exit']);
    expect(plan.holdout).toEqual({ percent: 5, minSampleSize: 200 });

    const built = await api().call('campaigns.fromBrief', { briefId: created.artifactId });
    const byKey = Object.fromEntries(built.artifacts.map((item: { key: string }) => [item.key, item])) as Record<
      string,
      { artifactId: string; key: string }
    >;
    const journeyArtifact = await api().call('artifacts.get', { artifactId: byKey.journey!.artifactId });
    const nodes = (journeyArtifact.version.content as any).nodes as any[];
    expect(nodes[0].config.segment).toBe(byKey.segment!.artifactId);
    expect(nodes.find((node: any) => node.kind === 'email').config.template).toBe(byKey.email_template!.artifactId);
    expect(nodes.find((node: any) => node.kind === 'sms').config.template).toBe(byKey.sms_template!.artifactId);
    const campaign = await api().call('artifacts.get', { artifactId: built.campaignId });
    expect((campaign.version.content as any).members.map((member: { artifactId: string }) => member.artifactId)).toEqual(
      expect.arrayContaining([
        byKey.segment!.artifactId,
        byKey.email_template!.artifactId,
        byKey.sms_template!.artifactId,
        byKey.journey!.artifactId,
      ]),
    );
  });

  it('refuses to build from a draft brief, and refuses an audience segment that is not published', async () => {
    const draftBrief = await api().call('artifacts.create', {
      type: 'campaign_brief',
      name: 'Never approved',
      content: brief(),
    });
    const refused = await rejects(api().call('campaigns.fromBrief', { briefId: draftBrief.artifactId }));
    expect(refused.message).toMatch(/no published version/i);

    const draftSegment = await api().call('artifacts.create', {
      type: 'segment',
      name: 'Draft audience',
      content: { condition: { consent: 'marketing_email' } },
    });
    const badBrief = await api().call('artifacts.create', {
      type: 'campaign_brief',
      name: 'Unpublished audience',
      content: brief({ audience: { description: 'Draft segment', segmentIds: [draftSegment.artifactId] } }),
    });
    const rejected = await rejects(api().call('artifacts.requestPublish', { artifactId: badBrief.artifactId, note: 'try' }));
    expect(rejected.message).toMatch(/not published/i);

    // A one-off schedule in the past is refused at approval, not only at send.
    const pastBrief = await api().call('artifacts.create', {
      type: 'campaign_brief',
      name: 'Yesterday',
      content: brief({ schedule: { mode: 'once', sendAt: '2020-01-01T09:00:00Z' } }),
    });
    const past = await rejects(api().call('artifacts.requestPublish', { artifactId: pastBrief.artifactId, note: 'try' }));
    expect(past.message).toMatch(/future/i);
  });
});
