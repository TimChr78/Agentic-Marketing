import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #906: a write tool accepts an optional idempotencyKey so an MCP client can retry safely. The
// argument is taken out before the command's own input validation and hash, and passed to the
// executor: two tool calls with one key run the handler once.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let mcp: Client;

const note = (name: string) => ({ type: 'note', name, content: { title: name, body: 'Once.' } });
const propertiesOf = (schema: unknown) =>
  (schema as { properties?: Record<string, unknown> })?.properties ?? ({} as Record<string, unknown>);

beforeAll(async () => {
  t = await startTestServer('test_v01424_mcp_idempotency', testPort(3488));
  owner = await t.signUp(`mcp-idempotency-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const token = await t.api(owner, ws).call('apiTokens.create', { name: 'retry client', scopes: ['artifacts:read', 'artifacts:write'] });
  mcp = new Client({ name: 'mcp-idempotency-test', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.token}` } },
    }),
  );
}, 120_000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await t?.close();
});

describe('MCP write tools take an idempotency key (#906)', () => {
  it('advertises the argument on writes, not reads', async () => {
    const tools = (await mcp.listTools()).tools;
    const create = tools.find((x) => x.name === 'artifacts.create')!;
    const list = tools.find((x) => x.name === 'artifacts.list')!;
    expect(propertiesOf(create.inputSchema).idempotencyKey).toMatchObject({ type: 'string', maxLength: 200 });
    expect(propertiesOf(list.inputSchema).idempotencyKey).toBeUndefined();
  });

  it('runs the handler once for two calls with the same key', async () => {
    const args = { ...note('MCP idempotent note'), idempotencyKey: 'mcp-note-1' };
    const first = await mcp.callTool({ name: 'artifacts.create', arguments: args });
    const second = await mcp.callTool({ name: 'artifacts.create', arguments: args });
    const a = first.structuredContent as { artifactId: string };
    const b = second.structuredContent as { artifactId: string };
    expect(b.artifactId).toBe(a.artifactId);
    const list = await t.api(owner, ws).call('artifacts.list', { type: 'note', limit: 50 });
    expect(list.artifacts.filter((x) => x.name === 'MCP idempotent note')).toHaveLength(1);
  });

  it('answers the reused-key conflict as a tool error with its stable reason', async () => {
    await mcp.callTool({ name: 'artifacts.create', arguments: { ...note('First use'), idempotencyKey: 'mcp-note-2' } });
    const conflict = await mcp.callTool({
      name: 'artifacts.create',
      arguments: { ...note('Different request'), idempotencyKey: 'mcp-note-2' },
    });
    expect(conflict.isError).toBe(true);
    const text = (conflict.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('already used for a different request');
    expect(JSON.parse(text).details.reason).toBe('idempotency_key_reused');
  });

  it('refuses an empty key instead of treating it as no key', async () => {
    const refused = await mcp.callTool({
      name: 'artifacts.create',
      arguments: { ...note('Empty key'), idempotencyKey: '' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]!.text).toContain('1 to 200 printable characters');
  });

  it('refuses a key outside the header bound or with spaces', async () => {
    const tooLong = await mcp.callTool({
      name: 'artifacts.create',
      arguments: { ...note('Too long'), idempotencyKey: 'k'.repeat(201) },
    });
    expect(tooLong.isError).toBe(true);
    expect((tooLong.content as { text: string }[])[0]!.text).toContain('1 to 200 printable characters');
    const spaced = await mcp.callTool({
      name: 'artifacts.create',
      arguments: { ...note('Spaced'), idempotencyKey: 'two words' },
    });
    expect(spaced.isError).toBe(true);
  });
});
