import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #942: prompts.test spends the workspace's paid LLM budget. It is a spend action now, so an agent
// needs a mandate that grants spend; a person needs nothing extra. Before the fix an agent with
// only artifacts:write and no mandate could queue a paid run as a "draft".

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let ws = '';
let token = '';
let agentId = '';
let promptId = '';

function answer(r: FakeRequest) {
  if (!r.system.includes('Choose exactly one option')) return { status: 500, error: 'unexpected request' };
  return { text: JSON.stringify({ option: 'a', rationale: 'The expected option.' }), inputTokens: 40, outputTokens: 10 };
}

async function agentCall(name: string, body: unknown) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

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
