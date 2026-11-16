import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// ai 7.0.172 keeps a failed tool call's error text in a UI message stream unless the call site
// sets `redactToolErrors: true`. The copilot does not use a UI message stream: it emits its own
// NDJSON from `streamText().stream`, and a failed MCP tool's output is one of the events it sends.
// A model-chosen argument can contain a credential, and an error message may echo it (an unknown
// purpose, a missing artifact). The executor redacts an AppError's message before MCP returns it;
// this test drives that end-to-end through the copilot route so the client-visible stream stays
// free of the value even though the failing tool was asked with it.

const SECRET = 'review_dummy_secret';

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;

async function answer(r: FakeRequest) {
  if (!r.user.includes('tool-error-redaction')) return { text: 'Nothing to do.' };
  // The tool failed: answer, so the turn ends and the client stream is complete.
  if (r.toolResults.at(-1)?.includes('"error"')) return { text: 'The tool failed; nothing to change.' };
  // The newly enabled tool is called with a value a model can produce (or copy from the
  // conversation); the command echoes it back in its not-found message.
  if (r.toolResults.length) return { toolCalls: [{ name: 'approvals__get', input: { approvalId: `password=${SECRET}` } }] };
  return { toolCalls: [{ name: 'tools__discover', input: { query: 'approvals get' } }] };
}

async function copilot(user: User, message: string) {
  const res = await fetch(`${t.base}/api/copilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: user.cookie, origin: t.base },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  const events = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { status: res.status, events };
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_copilot_tool_error_redaction', testPort(3494));
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

describe('a failing tool does not leak its error text to the copilot stream', () => {
  it('redacts the model-chosen credential in the tool result the client sees', async () => {
    const marker = `tool-error-redaction-${Date.now()}`;
    const r = await copilot(owner, `Try the list ${marker}`);
    expect(r.status).toBe(200);

    // The failing tool really ran, and its error is part of the stream.
    const failed = r.events.find((e) => e.type === 'toolResult' && e.name === 'approvals.get');
    expect(failed).toBeDefined();
    expect(failed.ok).toBe(false);

    // The error text the client receives names what to fix, never the credential the model passed.
    expect(JSON.stringify(failed.output)).toContain('does not exist in this workspace');
    expect(JSON.stringify(failed.output)).not.toContain(SECRET);
    expect(JSON.stringify(failed.output)).toContain('[redacted]');
    // The model is told what to fix, without the credential.
    const request = llm.requests.filter((x) => x.user.includes(marker)).at(-1)!;
    expect(JSON.stringify(request.messages.at(-1))).not.toContain(SECRET);
  });
});
