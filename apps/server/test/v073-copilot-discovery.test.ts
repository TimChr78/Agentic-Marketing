import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ACTIVE_TOOLS } from '../src/http/copilot-tools';
import { startTestServer, testPort, type User } from './harness';

// #356: the copilot cannot send the whole MCP catalog when its schemas cost more than the turn's
// 20,000-token allowance. It starts with a small core toolset and `tools.discover`, which enables
// an initially inactive command for the next step. This fake model exercises that path end to end:
// discover, call the newly enabled command, answer, and stop well inside the cap.

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
const TURN_CAP = 20_000;

async function answer(r: FakeRequest) {
  if (!r.user.includes('discover-audit')) return { text: 'Nothing to do.' };
  // The audit command ran: answer from its structured result.
  if (r.toolResults.some((x) => x.includes('"entries"'))) {
    const audit = JSON.parse(r.toolResults.at(-1)!) as { entries: unknown[] };
    return { text: `Audited ${audit.entries.length} entries.` };
  }
  // Discovery enabled audit__list for the next step: call it, which was not active before.
  if (r.toolResults.some((x) => x.includes('"enabled"'))) {
    return { toolCalls: [{ name: 'audit__list', input: { limit: 5 } }] };
  }
  // Only the core artifact toolset and discovery are advertised at first.
  return { toolCalls: [{ name: 'tools__discover', input: { query: 'audit list' } }] };
}

async function copilot(user: User, message: string) {
  const res = await fetch(`${t.base}/api/copilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: user.cookie },
    body: JSON.stringify({ message }),
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
  t = await startTestServer('test_v073_copilot_discovery', testPort(3502));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  await t.api(owner).call('aiProviders.create', {
    name: 'Copilot model',
    kind: 'openai-compatible',
    baseUrl: llm.baseUrl,
    models: { default: 'fake-copilot' },
    apiKey: 'sk-test-copilot-0123456789',
    useFor: ['copilot'],
    monthlyTokenBudget: null,
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('a copilot turn discovers commands within its budget (#356)', () => {
  it('enables an initially inactive tool and completes a useful turn inside 20k', async () => {
    const marker = `discover-audit-${Date.now()}`;
    const r = await copilot(owner, `What changed recently? ${marker}`);
    expect(r.status).toBe(200);

    // The model discovered, then called the command that the first request did not advertise.
    expect(r.events.filter((e) => e.type === 'tool').map((e) => e.name)).toEqual(['tools.discover', 'audit.list']);
    const discovery = r.events.find((e) => e.type === 'toolResult' && e.name === 'tools.discover')!;
    expect(discovery.output.enabled).toContain('audit__list');
    expect(discovery.output.tools.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(discovery.output)).not.toContain('approvals__approve');

    const requests = llm.requests.filter((x) => x.user.includes(marker));
    expect(requests).toHaveLength(3);
    // Every request is bounded; only the core set is advertised before discovery runs.
    for (const request of requests) expect(request.tools.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOLS);
    expect(requests[0].tools).toContain('artifacts__list');
    expect(requests[0].tools).not.toContain('audit__list');
    expect(requests[1].tools).toContain('audit__list');
    // Nothing ungranted leaked into the request.
    for (const request of requests) {
      for (const hidden of ['approvals__approve', 'journeys__enroll', 'profiles__erase', 'aiProviders__create'])
        expect(request.tools).not.toContain(hidden);
    }

    // The turn finished usefully, and the provider's usage stayed inside the reserved cap.
    const said = r.events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(said).toMatch(/^Audited \d+ entries\.$/);
    const done = r.events.find((e) => e.type === 'done')!;
    expect(done.usage.inputTokens + done.usage.outputTokens).toBeGreaterThan(0);
    expect(done.usage.inputTokens + done.usage.outputTokens).toBeLessThanOrEqual(TURN_CAP);

    // The usage row keeps the command that actually ran, not the local discovery helper.
    const row = (await t.api(owner).call('ai.calls', { kind: 'copilot' })).calls[0];
    expect(row.input.tools).toEqual(['audit.list']);
  });
});
