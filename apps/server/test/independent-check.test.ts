import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 18 (ADR-0016 §4.5, #231): before an autonomous (or held) action a second model
// compares the agent's intent with the action and the mandate. A match lets the action run; a
// mismatch, a missing provider or an unreadable answer drops it to a person (fail closed).

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let token = '';
let agentId = '';
let segmentId = '';
let templateId = '';
let providerId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const newsletterScope = { segments: [] as string[], purposes: ['marketing_email'], channels: ['email'] };

function answer(r: FakeRequest) {
  if (!r.system.includes('independent reviewer')) return { status: 500, error: 'unexpected request' };
  // The agent's own note says it is giving away tents: outside the mandate's purpose.
  if (r.user.includes('free tents'))
    return { text: JSON.stringify({ match: false, reason: 'The action promises a giveaway that is outside the mandate’s purpose.' }) };
  return { text: JSON.stringify({ match: true, reason: 'The action matches the intent and stays inside the mandate’s scope.' }) };
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_independent_check', testPort(3480));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  const api = t.api(owner);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
  const tpl = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Issue',
    content: { purpose: 'marketing_email', subject: 'This week', mjml },
  });
  await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
  templateId = tpl.artifactId;
  await api.call('profiles.import', {
    label: 'Independent check test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'News',
    content: { condition: { consent: 'marketing_email' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
  segmentId = seg.artifactId;
  await eventually(
    () => api.call('segments.refresh', { artifactId: seg.artifactId }),
    (r) => r.members === 3,
  );
  token = (
    await api.call('apiTokens.create', {
      name: 'Newsletter agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
  providerId = (
    await api.call('aiProviders.create', {
      name: 'Model',
      kind: 'anthropic-compatible',
      baseUrl: llm.baseUrl,
      models: { default: 'claude-sonnet-test' },
      apiKey: 'sk-test-0123456789',
      useFor: ['journeys'],
    })
  ).id;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Newsletter mandate',
    content: {
      agent: agentId,
      purpose: 'Send the weekly newsletter',
      validUntil: inDays(30),
      scope: { ...newsletterScope, segments: [segmentId] },
      levels: { 'send.broadcast': 3, 'content.publish': 3 },
      independentCheck: true,
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}, 90_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const draftBroadcast = async () =>
  (
    await call('artifacts.create', {
      type: 'broadcast',
      name: `Issue ${Date.now()}`,
      content: { template: templateId, segment: segmentId },
    })
  ).body.artifactId as string;

describe('the independent model check (#231)', () => {
  it('lets a matching action run autonomously, logs it and records the verdict in the ledger', async () => {
    const id = await draftBroadcast();
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Send this week’s issue to the newsletter readers' });
    expect(out.body.status).toBe('published');

    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 5 });
    expect(actions[0]).toMatchObject({ decision: 'allow', actionClass: 'send.broadcast' });
    expect(actions[0].reasons.join(' ')).toContain('Independent check');
    expect(actions[0].reasons.join(' ')).toContain('matches the intent');

    // The check is an AI call of its own, with a compact prompt and no secrets.
    const { calls } = await t.api(owner).call('ai.calls', { kind: 'check' });
    expect(calls[0]).toMatchObject({ kind: 'check', status: 'done', output: { match: true } });
    expect(calls[0].rationale).toContain('matches the intent');
    const req = llm.requests.at(-1)!;
    expect(req.system).toContain('untrusted');
    expect(req.user).toContain('<mandate>');
    expect(req.user).toContain('Send the weekly newsletter');
  });

  it('sends a mismatch to a person with the model’s reason', async () => {
    const id = await draftBroadcast();
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Give away free tents to everyone' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Independent check');
    expect(out.body.heldBecause.join(' ')).toContain('giveaway that is outside the mandate’s purpose');
  });

  it('fails closed when no AI provider is set up', async () => {
    // Draft while the provider still exists; then remove it and publish, as an operator might.
    const id = await draftBroadcast();
    await t.api(owner).call('aiProviders.delete', { id: providerId });
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Send this week’s issue' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Independent check');
    expect(out.body.heldBecause.join(' ')).toContain('no AI provider');
  });
});
