import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #941: the AI budget counts what the provider billed. A failed structured answer keeps the usage
// the AI SDK reports; when usage is unknown the reserved estimate is recorded instead of zero.
// A step holds its budget for the billing period, and a retry settles a crashed attempt's hold
// instead of holding twice.

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let ws = '';
let providerId = '';

let holdSignal: (() => void) | null = null;
let holdRelease: (() => void) | null = null;

const answer = async (r: FakeRequest) => {
  if (r.user.includes('invalid-answer')) return { text: 'not the JSON schema the prompt asked for', inputTokens: 120, outputTokens: 30 };
  if (r.user.includes('provider-fail')) return { status: 500, error: 'upstream exploded' };
  if (r.user.includes('hold-gate')) {
    holdSignal?.();
    await new Promise<void>((resolve) => {
      holdRelease = resolve;
    });
    return { text: JSON.stringify({ option: 'a', rationale: 'Held for the TTL probe.' }), inputTokens: 11, outputTokens: 3 };
  }
  return { text: JSON.stringify({ option: 'a', rationale: 'The expected option.' }), inputTokens: 40, outputTokens: 10 };
};

const decidePrompt = (tests: { name: string; marker?: string }[]) => ({
  kind: 'decide' as const,
  instructions: 'Pick one option.',
  options: [
    { key: 'a', description: 'First' },
    { key: 'b', description: 'Second' },
  ],
  tests: tests.map((test) => ({
    name: test.name,
    traits: test.marker ? { marker: test.marker } : {},
    expect: { options: ['a'] },
  })),
});

async function runToEnd(artifactId: string) {
  const api = t.api(owner);
  const { runId } = await api.call('prompts.test', { artifactId });
  return eventually(
    () => api.call('prompts.testRun', { runId }),
    (r) => r.status === 'done',
    20_000,
  );
}

const usedOf = async () => (await t.api(owner).call('aiProviders.list', {})).providers.find((p) => p.id === providerId)!.usedThisMonth;

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_v01424_ai_budget', testPort(4682));
  owner = await t.signUp(`owner-budget-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  providerId = (
    await t.api(owner).call('aiProviders.create', {
      name: 'Budget model',
      kind: 'openai-compatible',
      baseUrl: llm.baseUrl,
      models: { default: 'fake-budget' },
      apiKey: 'sk-test-budget-0123456789',
      useFor: ['journeys'],
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('failed calls keep their billed usage (#941)', () => {
  it('records the usage of an invalid structured answer instead of zero', async () => {
    const api = t.api(owner);
    const prompt = await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Invalid answers',
      content: decidePrompt([{ name: 'invalid', marker: 'invalid-answer' }]),
    });
    const before = await usedOf();
    const run = await runToEnd(prompt.artifactId);
    expect(run.cases[0]).toMatchObject({ status: 'failed', inputTokens: 120, outputTokens: 30 });
    expect(run.cases[0].problems.join(' ')).toContain('model call failed');
    expect((await usedOf()) - before).toBe(150);
    const [{ rows }] = await Promise.all([
      t.srv.db.admin.query<{ usage_estimated: boolean; billed_at: Date | null; reservation_id: string | null }>(
        `SELECT usage_estimated, billed_at, reservation_id FROM ai_calls
         WHERE workspace_id = $1 AND kind = 'test' AND prompt_id = $2`,
        [ws, prompt.artifactId],
      ),
    ]);
    expect(rows[0]).toMatchObject({ usage_estimated: false, reservation_id: null });
    expect(rows[0]!.billed_at).not.toBeNull();
  }, 60_000);

  it('records the reserved estimate when an error carries no usage', async () => {
    const api = t.api(owner);
    const prompt = await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Provider failure',
      content: decidePrompt([{ name: 'failed', marker: 'provider-fail' }]),
    });
    const before = await usedOf();
    const run = await runToEnd(prompt.artifactId);
    expect(run.cases[0].status).toBe('failed');
    const tokens = (run.cases[0].inputTokens as number) + (run.cases[0].outputTokens as number);
    expect(tokens).toBeGreaterThan(0);
    expect((await usedOf()) - before).toBe(tokens);
    const { rows } = await t.srv.db.admin.query<{ usage_estimated: boolean; billed_at: Date | null }>(
      `SELECT usage_estimated, billed_at FROM ai_calls
       WHERE workspace_id = $1 AND kind = 'test' AND prompt_id = $2`,
      [ws, prompt.artifactId],
    );
    expect(rows[0]?.usage_estimated).toBe(true);
    expect(rows[0]?.billed_at).not.toBeNull();
  }, 60_000);
});

describe('step holds use the billing period (#941)', () => {
  it('reserves a prompt test for more than the five-minute default', async () => {
    const api = t.api(owner);
    const prompt = await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Held run',
      content: decidePrompt([{ name: 'held', marker: 'hold-gate' }]),
    });
    const entered = new Promise<void>((resolve) => {
      holdSignal = resolve;
    });
    const { runId } = await api.call('prompts.test', { artifactId: prompt.artifactId });
    await entered;
    const { rows } = await t.srv.db.admin.query<{ expires_at: Date; tokens: number }>(
      'SELECT expires_at, tokens FROM ai_token_reservations WHERE workspace_id = $1 AND provider_id = $2',
      [ws, providerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 24 * 3_600_000);
    holdRelease?.();
    await eventually(
      () => api.call('prompts.testRun', { runId }),
      (r) => r.status === 'done',
      20_000,
    );
    expect((await t.srv.db.admin.query('SELECT id FROM ai_token_reservations WHERE workspace_id = $1', [ws])).rows).toHaveLength(0);
  }, 60_000);

  it('settles a crashed attempt’s hold on the retry instead of holding twice', async () => {
    const api = t.api(owner);
    const prompt = await api.call('artifacts.create', {
      type: 'prompt',
      name: 'Retried run',
      content: decidePrompt([{ name: 'retry-me' }]),
    });
    const reservationId = newId('rsv');
    const callId = newId('aic');
    const runId = newId('run');
    await t.srv.db.admin.query(
      `INSERT INTO ai_token_reservations (workspace_id, id, provider_id, tokens, expires_at)
       VALUES ($1, $2, $3, 500, now() + interval '30 days')`,
      [ws, reservationId, providerId],
    );
    await t.srv.db.admin.query(
      `INSERT INTO ai_calls (workspace_id, id, kind, status, lease_until, attempts, provider_id, prompt_id, prompt_version, input, reservation_id, created_at)
       VALUES ($1, $2, 'test', 'running', now() - interval '1 second', 1, $3, $4, 1, $5::jsonb, $6, now())`,
      [ws, callId, providerId, prompt.artifactId, JSON.stringify({ runId, index: 0, test: 'retry-me' }), reservationId],
    );

    const run = await eventually(
      async () => {
        const { rows } = await t.srv.db.admin.query<{
          status: string;
          input_tokens: number;
          output_tokens: number;
          usage_estimated: boolean;
        }>('SELECT status, input_tokens, output_tokens, usage_estimated FROM ai_calls WHERE workspace_id = $1 AND id = $2', [ws, callId]);
        return rows[0];
      },
      (row) => row?.status === 'done' || row?.status === 'failed',
      30_000,
    );
    expect(run?.status).toBe('done');
    // The crashed attempt's 500-token hold was settled as estimated usage, then the retry's own
    // 50 tokens were added: the hold is gone and nothing was freed.
    expect(run!.input_tokens + run!.output_tokens).toBe(550);
    expect(run!.usage_estimated).toBe(true);
    const held = await t.srv.db.admin.query('SELECT id FROM ai_token_reservations WHERE workspace_id = $1 AND id = $2', [
      ws,
      reservationId,
    ]);
    expect(held.rows).toHaveLength(0);
    expect((await api.call('ai.calls', { kind: 'test' })).calls.length).toBeGreaterThan(0);
  }, 60_000);
});
