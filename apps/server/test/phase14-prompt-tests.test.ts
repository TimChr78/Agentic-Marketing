import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, type User } from './harness';

// Phase 14, #56: a prompt test run reports every case, including the ones still waiting, with its
// latency and tokens; the runs list lets the Tests tab resume polling one that was left behind.

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let promptId = '';
let ws = '';

const person = (r: FakeRequest) => JSON.parse(r.user.match(/<person>\n([\s\S]*)\n<\/person>/)?.[1] ?? '{}');

function answer(r: FakeRequest) {
  if (r.system.includes('Choose exactly one option')) {
    const vip = Number(person(r).traits?.lifetime_value ?? 0) > 1000;
    return {
      text: JSON.stringify({ option: vip ? 'vip' : 'standard', rationale: vip ? 'High lifetime value.' : 'Regular customer.' }),
      inputTokens: 120,
      outputTokens: 30,
    };
  }
  return { status: 500, error: 'unexpected request' };
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_p14_prompt_tests', 3461);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('aiProviders.create', {
    name: 'Model',
    kind: 'anthropic-compatible',
    baseUrl: llm.baseUrl,
    models: { default: 'claude-sonnet-test' },
    apiKey: 'sk-test-0123456789',
    useFor: ['journeys'],
  });
  promptId = (
    await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Tier',
      content: {
        kind: 'decide',
        instructions: 'Pick the tone for the next offer.',
        options: [
          { key: 'vip', description: 'A loyal, high-value customer: early access' },
          { key: 'standard', description: 'Everyone else: the regular offer' },
        ],
        tests: [
          { name: 'big spender', traits: { lifetime_value: 2400 }, expect: { options: ['vip'] } },
          { name: 'new customer', traits: { lifetime_value: 40 }, expect: { options: ['standard'] } },
          // The model says standard here, so this case is a failure and still gets usage.
          { name: 'wrong expectation', traits: { lifetime_value: 20 }, expect: { options: ['vip'] } },
        ],
      },
    })
  ).artifactId;
}, 60_000);
afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('prompt test runs (#56)', () => {
  it('lists every case with status, latency and tokens, and totals the run', async () => {
    const api = t.api(owner);
    const { runId, queued } = await api.call('prompts.test', { artifactId: promptId });
    expect(queued).toBe(3);

    // Even before the worker has answered, the run has the full list of cases to progress against.
    const first = await api.call('prompts.testRun', { runId });
    expect(first.total).toBe(3);
    expect(first.cases.map((c: { name: string }) => c.name)).toEqual(['big spender', 'new customer', 'wrong expectation']);
    expect(first.cases.map((c: { index: number }) => c.index)).toEqual([0, 1, 2]);
    for (const c of first.cases) expect(['pending', 'running', 'done', 'failed']).toContain(c.status);

    const done = await eventually(
      () => api.call('prompts.testRun', { runId }),
      (r) => r.status === 'done',
    );
    expect(done).toMatchObject({ version: 1, total: 3, finished: 3, pending: 0, passed: 2, failed: 1 });
    expect(done.cases.map((c: { status: string }) => c.status)).toEqual(['done', 'done', 'failed']);
    for (const c of done.cases) {
      expect(c.inputTokens).toBe(120);
      expect(c.outputTokens).toBe(30);
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(done.inputTokens).toBe(360);
    expect(done.outputTokens).toBe(90);
    expect(done.latencyMs).toBe(done.cases.reduce((n: number, c) => n + (c.latencyMs ?? 0), 0));
    expect(done.finishedAt).toBeTruthy();
    expect(done.results).toHaveLength(3);

    // A case still in flight is listed as running, not omitted, and the run reports how far it is.
    await t.srv.db.admin.query(
      `UPDATE ai_calls SET status = 'running', lease_until = now() + interval '1 hour', finished_at = NULL
       WHERE workspace_id = $1 AND kind = 'test' AND input ->> 'runId' = $2 AND input ->> 'index' = '1'`,
      [ws, runId],
    );
    const resumed = await api.call('prompts.testRun', { runId });
    expect(resumed).toMatchObject({ status: 'running', total: 3, finished: 2, pending: 1, passed: 1, failed: 1 });
    expect(resumed.cases[1].status).toBe('running');
    expect(resumed.cases[1].answer).toBeNull();
    expect((await api.call('prompts.testRuns', { artifactId: promptId, limit: 1 })).runs[0]).toMatchObject({
      runId,
      status: 'running',
      pending: 1,
    });

    await t.srv.db.admin.query(
      `UPDATE ai_calls SET status = 'done', lease_until = NULL, finished_at = now()
       WHERE workspace_id = $1 AND kind = 'test' AND input ->> 'runId' = $2 AND input ->> 'index' = '1'`,
      [ws, runId],
    );
    expect((await api.call('prompts.testRun', { runId })).status).toBe('done');
  });

  it('lists runs newest first with their status and totals, so the tab can resume one', async () => {
    const api = t.api(owner);
    const first = (await api.call('prompts.testRuns', { artifactId: promptId })).runs[0];
    expect(first).toMatchObject({
      status: 'done',
      version: 1,
      total: 3,
      finished: 3,
      pending: 0,
      passed: 2,
      failed: 1,
      inputTokens: 360,
      outputTokens: 90,
    });
    expect(first.startedAt).toBeTruthy();
    expect(first.finishedAt).toBeTruthy();

    const second = await api.call('prompts.test', { artifactId: promptId });
    await eventually(
      () => api.call('prompts.testRun', { runId: second.runId }),
      (r) => r.status === 'done',
    );
    const list = await api.call('prompts.testRuns', { artifactId: promptId, version: 1, limit: 1 });
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ runId: second.runId, status: 'done', version: 1, total: 3 });
  });
});
