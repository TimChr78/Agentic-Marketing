import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #264: a mandate's scope must cover every path that reaches people, not only broadcasts.
// `touches` is filled for direct sends (the template's purpose/topic and the e-mail channel) and
// for journeys (the journey's purpose, its step channels and its entry/condition segments), and
// segment/audience-sync publishes report their own audience.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agentId = '';
let token = '';
let news = '';
let other = '';
let newsletter = '';
let onboarding = '';
let sms = '';
let ada = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  t = await startTestServer('test_scope_touches', testPort(3492));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  const api = t.api(owner);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });

  const template = async (name: string, purpose: string) => {
    const created = await api.call('artifacts.create', {
      type: 'email_template',
      name,
      content: { purpose, subject: name, mjml },
    });
    await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'setup' });
    return created.artifactId as string;
  };
  newsletter = await template('Newsletter', 'marketing_email');
  onboarding = await template('Welcome', 'onboarding');
  const smsTemplate = await api.call('artifacts.create', {
    type: 'sms_template',
    name: 'SMS',
    content: { purpose: 'marketing_email', body: 'Hej {{ profile.firstName }}' },
  });
  await api.call('artifacts.requestPublish', { artifactId: smsTemplate.artifactId, note: 'setup' });
  sms = smsTemplate.artifactId;

  await api.call('profiles.import', {
    label: 'Scope touches test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  ada = (
    await eventually(
      () => api.call('profiles.find', { type: 'email', value: 'ada@example.com' }),
      (r) => !!r.profileId,
    )
  ).profileId as string;

  for (const [name, set] of [
    ['News', (id: string) => (news = id)],
    ['Other', (id: string) => (other = id)],
  ] as const) {
    const seg = await api.call('artifacts.create', { type: 'segment', name, content: { condition: { consent: 'marketing_email' } } });
    await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
    set(seg.artifactId);
    await eventually(
      () => api.call('segments.refresh', { artifactId: seg.artifactId }),
      (r) => r.members === 3,
    );
  }

  token = (
    await api.call('apiTokens.create', {
      name: 'Scope agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', {
    maxLevel: { 'send.direct': 3, 'journey.live': 3, 'content.publish': 3, 'audience.publish': 3 },
  });
}, 120_000);
afterAll(() => t?.close());

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** A person publishes a mandate for the agent. */
async function grant(content: Record<string, unknown>) {
  const api = t.api(owner);
  const created = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Scope mandate',
    content: { agent: agentId, purpose: 'Send the newsletter', validUntil: inDays(30), ...content } as never,
  });
  const out = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'grant' });
  expect(out.status).toBe('published');
  return created.artifactId as string;
}

const draftJourney = async (content: unknown) =>
  (await call('artifacts.create', { type: 'journey', name: `Journey ${Date.now()}`, content })).body.artifactId as string;

let mandateId = '';

describe('mandate scope covers direct sends (#264)', () => {
  beforeAll(async () => {
    mandateId = await grant({
      scope: { segments: [news], purposes: ['marketing_email'], topics: [], channels: ['email'] },
      levels: { 'send.direct': 3, 'journey.live': 3, 'content.publish': 3, 'audience.publish': 3 },
    });
  });

  it('a direct send for a purpose outside the scope is refused, and the reason says which purpose', async () => {
    const out = await call('messages.sendEmail', { profileId: ada, templateId: onboarding });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('Purpose onboarding is outside this agent’s mandate');

    const { actions } = await t.api(owner).call('agents.activity', { agentId, decision: 'deny', limit: 1 });
    expect(actions[0]).toMatchObject({ command: 'messages.sendEmail', actionClass: 'send.direct', decision: 'deny', ok: false });
    expect(actions[0].reasons.join(' ')).toContain('Purpose onboarding is outside this agent’s mandate');
    expect(actions[0].impact).toMatchObject({ touches: { purposes: ['onboarding'], channels: ['email'] } });
  });

  it('a direct send inside the scope runs', async () => {
    const out = await call('messages.sendEmail', { profileId: ada, templateId: newsletter });
    expect(out.status).toBe(200);
    expect(out.body.status).not.toBe('failed');
    const { actions } = await t.api(owner).call('agents.activity', { agentId, decision: 'allow', actionClass: 'send.direct', limit: 1 });
    expect(actions[0]).toMatchObject({
      command: 'messages.sendEmail',
      decision: 'allow',
      mandateId,
      impact: { people: 1, reversible: false, touches: { purposes: ['marketing_email'], channels: ['email'] } },
    });
  });

  it('a segment publish reports its own audience, so publishing one outside the scope goes to a person', async () => {
    const seg = await call('artifacts.create', {
      type: 'segment',
      name: 'Strangers',
      content: { condition: { consent: 'marketing_email' } },
    });
    const out = await call('artifacts.requestPublish', { artifactId: seg.body.artifactId, note: 'an audience outside my mandate' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain(`Audience ${seg.body.artifactId} is outside this agent’s mandate`);
  });

  it('publishing a segment inside the scope stays autonomous', async () => {
    expect((await call('artifacts.updateDraft', { artifactId: news, content: { condition: { consent: 'marketing_email' } } })).status).toBe(
      200,
    );
    const out = await call('artifacts.requestPublish', { artifactId: news, note: 'refresh the newsletter audience' });
    expect(out.body.status).toBe('published');
  });
});

describe('mandate scope covers journeys (#264)', () => {
  it('a journey whose entry segment is outside the scope goes to a person', async () => {
    const id = await draftJourney({
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Joins', config: { segment: other } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'a journey for another audience' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain(`Audience ${other} is outside this agent’s mandate`);

    const { actions } = await t.api(owner).call('agents.activity', { agentId, decision: 'ask', actionClass: 'journey.live', limit: 1 });
    expect(actions[0]).toMatchObject({ command: 'artifacts.requestPublish', decision: 'ask' });
    expect(actions[0].impact).toMatchObject({ touches: { purposes: ['marketing_email'], segments: [other] } });
  });

  it('a journey with an SMS step goes to a person when the mandate allows only e-mail', async () => {
    const id = await draftJourney({
      purpose: 'marketing_email',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' } },
        { id: 'mail', kind: 'email', label: 'Welcome', config: { template: newsletter } },
        { id: 'text', kind: 'sms', label: 'Ping', config: { template: sms } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'a journey with a text step' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Channel sms is outside this agent’s mandate');
  });

  it('enrolling people into a journey outside the scope is refused', async () => {
    // A person creates and publishes it, so the journey exists; enrolling is the agent's write.
    const api = t.api(owner);
    const created = await api.call('artifacts.create', {
      type: 'journey',
      name: `Person journey ${Date.now()}`,
      content: {
        purpose: 'marketing_email',
        nodes: [
          { id: 'trigger', kind: 'trigger', label: 'Joins', config: { segment: other } },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'setup' });
    const out = await call('journeys.enroll', { artifactId: created.artifactId, profileIds: [ada] });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain(`Audience ${other} is outside this agent’s mandate`);
  });
});
