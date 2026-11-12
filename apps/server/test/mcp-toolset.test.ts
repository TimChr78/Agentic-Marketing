import { agentPrincipal, type Principal } from '@agentic-marketing/commands';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { mcpServerFor } from '../src/http/mcp';
import { commands } from '../src/registry';

// #364: a hosted run has no OAuth step-up and no person to ask, so its MCP catalogue is built with
// `stepUp: false` — only granted commands, never the "Needs the … permission" invitation. OAuth
// clients keep the step-up listing (their person can grant the scope), and people-only commands
// are never offered to an agent at all.

const executor = { execute: async () => ({}) } as never;

async function toolsOf(principal: Principal, stepUp: boolean): Promise<{ name: string; description?: string }[]> {
  const server = mcpServerFor(principal, executor, { stepUp });
  const client = new Client({ name: 'toolset-test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description }));
  } finally {
    await client.close().catch(() => {});
  }
}

const permissionOf = new Map<string, string | null>(commands.map((c) => [c.name as string, c.permission]));
const humansOnly = new Set<string>(commands.filter((c) => c.humansOnly).map((c) => c.name as string));
const granted = (p: Principal) => p.permissions as ReadonlySet<string>;

describe('hosted MCP toolset (#364)', () => {
  // The tools a principal sees do not consult the agent row; the executor does. A placeholder
  // record keeps these unit tests to the catalogue.
  const record = (id: string) => ({ id: `agt_${id}`.padEnd(36, '0'), name: id, status: 'active' as const, statusReason: null });
  const viewer = agentPrincipal('usr_viewer', 'client_viewer', 'ws_1', 'viewer', ['artifacts:read'], record('viewer'));

  it('offers a viewer-sponsored run only tools its scopes grant', async () => {
    const tools = await toolsOf(viewer, false);
    expect(tools.map((t) => t.name)).toContain('agents.get');
    for (const tool of tools) {
      const permission = permissionOf.get(tool.name);
      expect(permission, `${tool.name} is a command tool`).toBeTruthy();
      expect(granted(viewer).has(permission!), `${tool.name} needs ${permission}`).toBe(true);
      expect(tool.description ?? '').not.toContain('calling it asks the person to grant it');
      expect(humansOnly.has(tool.name)).toBe(false);
    }
    // The write and publish commands a viewer's role could not grant are absent entirely.
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('artifacts.create');
    expect(names).not.toContain('artifacts.requestPublish');
  });

  it('offers a marketer-scoped run exactly the commands those scopes grant', async () => {
    const scopes = ['artifacts:read', 'artifacts:write', 'messages:send'];
    const marketer = agentPrincipal('usr_marketer', 'client_marketer', 'ws_1', 'marketer', scopes, record('marketer'));
    const names = (await toolsOf(marketer, false)).map((t) => t.name);
    expect(names).toContain('artifacts.create');
    expect(names).toContain('messages.sendEmail');
    // The role could also erase profiles; the client was not granted that scope, so it is absent.
    expect(names).not.toContain('profiles.erase');
    for (const name of names) expect(granted(marketer).has(permissionOf.get(name)!), name).toBe(true);
  });

  it('never offers people-only commands even to a role that could run them', async () => {
    const owner = agentPrincipal('usr_owner', 'client_owner', 'ws_1', 'owner', ['artifacts:read', 'workspace:admin'], record('owner'));
    const names = (await toolsOf(owner, true)).map((t) => t.name);
    expect(humansOnly.has('agents.createHosted')).toBe(true);
    expect(names).not.toContain('agents.createHosted');
    expect(names).not.toContain('agents.deleteHosted');
  });

  it('keeps the in-app copilot default unchanged: no unsolicited tools', async () => {
    // The copilot (and its agent-as copilot) calls mcpServerFor without `stepUp`; the default is
    // and stays "granted tools only", the same catalogue a hosted run now gets.
    const server = mcpServerFor(viewer, executor);
    const client = new Client({ name: 'copilot-toolset-test', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('agents.get');
      expect(names).not.toContain('artifacts.create');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('keeps the OAuth step-up listing, which a hosted run deliberately does not use', async () => {
    // A marketer's role allows writes; this connection was only granted reads. A hosted run with
    // the same mandate must not see the write, while an OAuth client may ask the person for it.
    const partial = agentPrincipal('usr_partial', 'client_partial', 'ws_1', 'marketer', ['artifacts:read'], record('partial'));
    const plain = (await toolsOf(partial, false)).map((t) => t.name);
    const stepped = await toolsOf(partial, true);
    const steppedNames = stepped.map((t) => t.name);
    expect(plain).not.toContain('artifacts.create');
    expect(steppedNames).toContain('artifacts.create');
    const invited = stepped.find((t) => t.name === 'artifacts.create');
    expect(invited?.description).toContain('which this connection was not granted');
  });
});
