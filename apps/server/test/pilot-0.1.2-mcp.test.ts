import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// MCP guidance for agents: server instructions, the same text as a resource, and the type filter
// that keeps artifacts.types from returning the full ~66 KB of schemas.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;

beforeAll(async () => {
  t = await startTestServer('test_pilot_mcp', testPort(3312));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const structured = (r: any) => r.structuredContent as any;

describe('MCP guidance', () => {
  it('returns instructions in initialize', () => {
    const instructions = agent.client.getInstructions();
    expect(instructions).toContain('requestPublish');
    expect(instructions).toContain('template-per-issue');
  });

  it('serves the same text as the guide resource', async () => {
    const { resources } = await agent.client.listResources();
    expect(resources.find((r) => r.uri === 'agentic-marketing://guide')).toMatchObject({ mimeType: 'text/markdown' });
    const read = await agent.client.readResource({ uri: 'agentic-marketing://guide' });
    expect(read.contents[0]).toMatchObject({ uri: 'agentic-marketing://guide', mimeType: 'text/markdown' });
    expect((read.contents[0] as { text: string }).text).toBe(agent.client.getInstructions());
  });

  it('returns one type when asked for it', async () => {
    const res = await agent.client.callTool({ name: 'artifacts.types', arguments: { type: 'broadcast' } });
    const { types } = structured(res);
    expect(types).toHaveLength(1);
    expect(types[0].type).toBe('broadcast');
    expect(types[0].description).toMatch(/template-per-issue/);
  });

  it('returns every type with no arguments', async () => {
    const res = await agent.client.callTool({ name: 'artifacts.types', arguments: {} });
    expect(structured(res).types.length).toBeGreaterThan(1);
  });

  it('rejects an unknown type with the valid names', async () => {
    const res = await agent.client.callTool({ name: 'artifacts.types', arguments: { type: 'newsletter' } });
    expect(res.isError).toBe(true);
    // The MCP SDK validates the input against the tool schema first and answers in plain text.
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain('Unknown artifact type');
    expect(text).toContain('broadcast');
  });
});
