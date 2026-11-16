import { type FakeRequest, fakeLlm, fakeSystemOne } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #942: prompts.test, ai.classify and ai.score spend the workspace's paid LLM budget. They are
// spend actions now, so an agent needs a mandate that grants spend; a person needs nothing extra.

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let sys: Awaited<ReturnType<typeof fakeSystemOne>>;
let owner: User;
let ws = '';
let token = '';
let agentId = '';
let promptId = '';
let classifyPromptId = '';

function answer(r: FakeRequest) {
  if (r.system.includes('Choose exactly one label'))
    return { text: JSON.stringify({ label: 'a', rationale: 'The expected label.' }), inputTokens: 40, outputTokens: 10 };
  if (!r.system.includes('Choose exactly one option')) return { status: 500, error: 'unexpected request' };
  return { text: JSON.stringify({ option: 'a', rationale: 'The expected option.' }), inputTokens: 40, outputTokens: 10 };
}

async function callWith(token: string, name: string, body: unknown) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const agentCall = (name: string, body: unknown) => callWith(token, name, body);

const queued = async () =>
  (
    await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_calls WHERE workspace_id = $1 AND prompt_id = $2', [
      ws,
      promptId,
    ])
  ).rows[0]!.n;

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  llm = await fakeLlm(answer);
  sys = await fakeSystemOne((r) => {
    const answers: Record<string, Record<string, unknown>> = {};
    for (const id of Object.keys(r.questions)) answers[id] = { type: 'noul', noul: 0.8 };
    return { answers, inputTokens: 50, outputTokens: 5 };
  });
  t = await startTestServer('test_v01424_prompt_spend', testPort(4684));
  owner = await t.signUp(`owner-prompt-spend-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('aiProviders.create', {
    name: 'Prompt model',
    kind: 'openai-compatible',
    baseUrl: llm.baseUrl,
    models: { default: 'fake-prompt' },
    apiKey: 'sk-test-prompt-0123456789',
    useFor: ['journeys'],
  });
  await api.call('aiProviders.create', {
    name: 'Decision model',
    kind: 'decision',
    baseUrl: sys.baseUrl,
    models: { default: 'typesafe/jev' },
    apiKey: 'sk-test-decisions-0123456789',
    useFor: ['decisions'],
  });
  classifyPromptId = (
    await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Classify spend',
      content: {
        kind: 'classify',
        instructions: 'Label the text.',
        options: [
          { key: 'a', description: 'First label' },
          { key: 'b', description: 'Second label' },
        ],
      },
    })
  ).artifactId;
  await api.call('artifacts.requestPublish', { artifactId: classifyPromptId, note: 'setup' });
  promptId = (
    await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Spend check',
      content: {
        kind: 'decide',
        instructions: 'Pick the tone.',
        options: [
          { key: 'a', description: 'First' },
          { key: 'b', description: 'Second' },
        ],
        tests: [{ name: 'one', traits: {}, expect: { options: ['a'] } }],
      },
    })
  ).artifactId;
  token = (await api.call('apiTokens.create', { name: 'Draft-only agent', scopes: ['artifacts:write'] })).token;
  // The first credential use creates the agent; the command itself is refused for lack of a
  // mandate, which is exactly what the first test proves.
  expect((await agentCall('agents.get', {})).status).toBe(403);
  agentId = (await t.srv.db.admin.query<{ id: string }>('SELECT id FROM agents WHERE workspace_id = $1 ORDER BY created_at LIMIT 1', [ws]))
    .rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
  await sys?.close();
});

describe('prompts.test spends budget (#942)', () => {
  it('refuses an agent with only artifacts:write and no mandate, queueing nothing', async () => {
    const before = await queued();
    const denied = await agentCall('prompts.test', { artifactId: promptId });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('mandate');
    expect(await queued()).toBe(before);
  }, 60_000);

  it('lets an agent with a mandate that grants spend queue the run', async () => {
    const api = t.api(owner);
    await api.call('workspace.setAutonomy', { maxLevel: { spend: 3 } });
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Prompt test mandate',
      content: {
        agent: agentId,
        purpose: 'Run prompt test cases before shipping a prompt',
        validUntil: inDays(30),
        levels: { spend: 3 },
      } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');

    const before = await queued();
    const allowed = await agentCall('prompts.test', { artifactId: promptId });
    expect(allowed.status).toBe(200);
    expect(allowed.body.queued).toBe(1);
    expect(await queued()).toBe(before + 1);
  }, 60_000);

  it('lets a person queue the run without a mandate', async () => {
    const before = await queued();
    const run = await t.api(owner).call('prompts.test', { artifactId: promptId });
    expect(run.queued).toBe(1);
    expect(await queued()).toBe(before + 1);
  }, 60_000);
});

const meteredScopes = ['artifacts:read', 'artifacts:write', 'profiles:write'] as const;

async function makeMeteredAgent(name: string) {
  const { token: agentToken } = await t.api(owner).call('apiTokens.create', { name, scopes: [...meteredScopes] });
  const { body } = await callWith(agentToken, 'agents.get', {});
  return { token: agentToken, id: body.id as string };
}

async function grantSpend(id: string) {
  const api = t.api(owner);
  await api.call('workspace.setAutonomy', { maxLevel: { spend: 3 } });
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: `Spend mandate ${id}`,
    content: {
      agent: id,
      purpose: 'Run paid AI commands for this workspace',
      validUntil: inDays(30),
      levels: { spend: 3 },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}

const classifyCalls = async () =>
  (
    await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_calls WHERE workspace_id = $1 AND prompt_id = $2', [
      ws,
      classifyPromptId,
    ])
  ).rows[0]!.n;

const noul = { key: 'conversion_propensity', type: 'noul' as const, instructions: 'Is this person likely to convert?' };

describe('ai.classify spends budget (#942 review)', () => {
  it('refuses an agent without a spend mandate and lets a mandated agent and a person run it', async () => {
    const agent = await makeMeteredAgent('Classify agent');
    const before = await classifyCalls();
    const denied = await callWith(agent.token, 'ai.classify', { artifactId: classifyPromptId, text: 'Hello there' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('mandate');
    expect(await classifyCalls()).toBe(before);

    await grantSpend(agent.id);
    const allowed = await callWith(agent.token, 'ai.classify', { artifactId: classifyPromptId, text: 'Hello there' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.status).toBe('pending');

    const person = await t.api(owner).call('ai.classify', { artifactId: classifyPromptId, text: 'Hello there' });
    expect(person.status).toBe('pending');
    expect(await classifyCalls()).toBe(before + 2);
  }, 60_000);
});

describe('ai.score spends budget (#942 review)', () => {
  it('refuses an agent without a spend mandate and lets a mandated agent and a person run it', async () => {
    const agent = await makeMeteredAgent('Score agent');
    const call = (token: string) => callWith(token, 'ai.score', { questions: [noul], state: { plan: 'pro' } });
    const denied = await call(agent.token);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('mandate');

    await grantSpend(agent.id);
    const allowed = await call(agent.token);
    expect(allowed.status).toBe(200);
    expect(allowed.body.answers[0].probability).toBe(0.8);

    const person = await t.api(owner).call('ai.score', { questions: [noul], state: { plan: 'pro' } });
    expect(person.answers[0].probability).toBe(0.8);
  }, 60_000);
});
