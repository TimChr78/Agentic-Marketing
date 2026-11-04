import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #356: one copilot turn may not spend more than the allowance it reserved, which is at most the
// 20,000-token turn cap and at most what the provider's month has left. The fake model always
// uses the whole per-step output cap and reports the tokens of the prompt it was sent, so the
// turn's own accounting can be checked exactly. No real provider is called.

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let providerId = '';

const MAX_STEPS = 12;
const TURN_CAP = 20_000;

/** A model that keeps calling a tool and always writes its whole output cap. */
async function answer(r: FakeRequest) {
  if (r.user.includes('cancel-turn')) await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    toolCalls: [{ name: 'artifacts__list', input: { type: 'prompt' } }],
    // The provider reports the tokens of the messages it was sent, which is what the turn's own
    // prompt estimate is built from (and that estimate also counts the system text and tools).
    inputTokens: Math.ceil(JSON.stringify(r.messages).length / 4),
    outputTokens: r.maxOutputTokens ?? 2_000,
  };
}

async function copilot(user: User, message: string, signal?: AbortSignal) {
  const res = await fetch(`${t.base}/api/copilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: user.cookie },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!res.ok) return { status: res.status, body: await res.json(), events: [] as Record<string, any>[] };
  const events = (await res.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { status: res.status, body: null, events };
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_v073_copilot_budget', testPort(3488));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  providerId = (
    await t.api(owner).call('aiProviders.create', {
      name: 'Copilot model',
      kind: 'openai-compatible',
      baseUrl: llm.baseUrl,
      models: { default: 'fake-copilot' },
      apiKey: 'sk-test-copilot-0123456789',
      useFor: ['copilot'],
      monthlyTokenBudget: null,
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

const usedOf = async () => (await t.api(owner).call('aiProviders.list', {})).providers.find((p) => p.id === providerId)!.usedThisMonth;

describe('a copilot turn is capped by its reservation (#356)', () => {
  it('stops at the reserved allowance instead of overshooting a 21k month', async () => {
    const api = t.api(owner);
    const usedBefore = await usedOf();
    // A budget just above the turn cap: the old loop could spend 12 × (prompt + 2,000).
    await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: usedBefore + 21_000 });
    try {
      const marker = `cap-${Date.now()}`;
      const r = await copilot(owner, `List the prompts ${marker}`);
      expect(r.status).toBe(200);
      const done = r.events.find((e) => e.type === 'done')!;
      const turn = done.usage.inputTokens + done.usage.outputTokens;
      expect(turn).toBeGreaterThan(0);
      expect(turn).toBeLessThanOrEqual(TURN_CAP);

      // The row the turn recorded is the same usage the person was shown, and the reservation is
      // gone (the month counts the row, not a hold).
      const row = (await api.call('ai.calls', { kind: 'copilot' })).calls[0];
      expect(row.inputTokens + row.outputTokens).toBe(turn);
      expect((await usedOf()) - usedBefore).toBe(turn);

      // The loop stopped before MAX_STEPS because the allowance ran out, not because it finished.
      const requests = llm.requests.filter((x) => x.user.includes(marker));
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.length).toBeLessThan(MAX_STEPS);
      // Every step was capped by the turn's remaining allowance, never above the per-step cap.
      for (const request of requests) expect(request.maxOutputTokens ?? 0).toBeLessThanOrEqual(2_000);
    } finally {
      await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: null });
    }
  });

  it('refuses a turn when the remaining budget is below the minimum', async () => {
    const api = t.api(owner);
    const used = await usedOf();
    await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: used + 500 });
    try {
      const r = await copilot(owner, 'Are you there?');
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('budget');
      expect(await usedOf()).toBe(used);
    } finally {
      await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: null });
    }
  });

  it('records partial usage and releases the reservation when the person cancels', async () => {
    const api = t.api(owner);
    const before = (await api.call('ai.calls', { kind: 'copilot' })).calls.length;
    const controller = new AbortController();
    const res = await fetch(`${t.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ message: 'List the prompts cancel-turn' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // Wait until the first tool has run: one step's usage is now known.
    while (!seen.includes('"type":"toolResult"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await reader.cancel().catch(() => {});

    const calls = await eventually(
      async () => (await api.call('ai.calls', { kind: 'copilot' })).calls,
      (rows) => rows.length > before,
      15_000,
    );
    expect(calls.length).toBeGreaterThan(before);
    const row = calls[0];
    expect(row.inputTokens + row.outputTokens).toBeGreaterThan(0);
    // The usage row was written before the hold was released; nothing is left holding budget.
    const held = await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_token_reservations WHERE provider_id = $1', [
      providerId,
    ]);
    expect(held.rows[0].n).toBe(0);
  }, 30_000);
});
