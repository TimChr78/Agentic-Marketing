import { principalFromAccessToken } from '@agentic-marketing/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

// #187: an API token or MCP connection belongs to one brand. X-Workspace-Id only switches a
// person's session; a credential that sends a different workspace is refused, and the OAuth
// consent page binds the grant to the brand the person chooses.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let wsC = '';
let tokenA = '';
let tokenAId = '';
let noteB = '';

const rest = (token: string, name: string, body: unknown, workspaceId?: string) =>
  fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  t = await startTestServer('test_workspace_bound', testPort(3488));
  owner = await t.signUp(`bound-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']]);
  wsB = await t.workspaceWith([[owner, 'owner']]);
  wsC = await t.workspaceWith([[owner, 'viewer']]);
  const value = await t.api(owner, wsA).call('apiTokens.create', { name: 'brand A token', scopes: ['artifacts:read', 'artifacts:write'] });
  tokenA = value.token;
  tokenAId = value.id;
  noteB = (await t.api(owner, wsB).call('artifacts.create', { type: 'note', name: 'Only B', content: { title: 'B', body: 'B' } }))
    .artifactId;
}, 90_000);

afterAll(() => t?.close());

describe('one brand per API token (#187)', () => {
  it('acts in the brand it was created for and refuses X-Workspace-Id', async () => {
    const own = await rest(tokenA, 'workspace.get', {});
    expect(own.status).toBe(200);
    expect((await own.json()).id).toBe(wsA);

    const switched = await rest(tokenA, 'workspace.get', {}, wsB);
    expect(switched.status).toBe(403);
    expect((await switched.json()).message).toContain('bound to one brand');
  });

  it('cannot read another brand, with or without the header', async () => {
    const without = await rest(tokenA, 'artifacts.get', { artifactId: noteB });
    expect(without.status).toBe(404);
    const withHeader = await rest(tokenA, 'artifacts.get', { artifactId: noteB }, wsB);
    expect(withHeader.status).toBe(403);
  });

  it('lists only the bound brand in workspace.memberships', async () => {
    const out = await rest(tokenA, 'workspace.memberships', {});
    expect(out.status).toBe(200);
    const body = await out.json();
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual([wsA]);
  });

  it('shows the brand on creation and in the list, and creates a second-brand token with the header', async () => {
    const created = await t.api(owner, wsB).call('apiTokens.create', { name: 'brand B token', scopes: ['artifacts:read'] });
    expect(created.workspaceId).toBe(wsB);
    expect(created.workspaceName).toEqual(expect.any(String));
    expect(created.workspaceName.length).toBeGreaterThan(0);
    const list = await t.api(owner, wsB).call('apiTokens.list', {});
    expect(list.tokens.find((x) => x.id === created.id)).toMatchObject({ workspaceId: wsB, workspaceName: created.workspaceName });
    // The list from A never contains B's token.
    expect((await t.api(owner, wsA).call('apiTokens.list', {})).tokens.some((x) => x.id === created.id)).toBe(false);
  });

  it('records the token id and the brand in the audit log', async () => {
    await t.api(owner, wsA).call('apiTokens.update', { id: tokenAId, name: 'renamed A token' });
    await t.api(owner, wsA).call('apiTokens.revoke', { id: tokenAId });
    const { rows } = await t.srv.db.admin.query<{ command: string; target: string | null; workspace_id: string }>(
      "SELECT command, target, workspace_id FROM audit_log WHERE workspace_id = $1 AND command LIKE 'apiTokens.%' ORDER BY seq",
      [wsA],
    );
    for (const name of ['apiTokens.create', 'apiTokens.update', 'apiTokens.revoke']) {
      expect(rows.find((r) => r.command === name)).toMatchObject({ target: tokenAId, workspace_id: wsA });
    }
  });
});

describe('one brand per OAuth connection (#187)', () => {
  it('binds the grant to the brand chosen at consent', async () => {
    const agent = await connectAgent(t.base, owner, ['artifacts:read'], undefined, wsB);
    const ws = JSON.parse(textOf(await agent.client.callTool({ name: 'workspace.get', arguments: {} })));
    expect(ws.id).toBe(wsB);
    const memberships = JSON.parse(textOf(await agent.client.callTool({ name: 'workspace.memberships', arguments: {} })));
    expect(memberships.workspaces.map((w: { id: string }) => w.id)).toEqual([wsB]);

    const token = agent.provider.tokenSet.access_token as string;
    const switched = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-workspace-id': wsA,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.get', arguments: {} } }),
    });
    expect(switched.status).toBe(403);
    expect(await switched.text()).toContain('bound to one brand');
  });

  it('cannot see another brand’s artifacts', async () => {
    const noteA = (await t.api(owner, wsA).call('artifacts.create', { type: 'note', name: 'Only A', content: { title: 'A', body: 'A' } }))
      .artifactId;
    const agent = await connectAgent(t.base, owner, ['artifacts:read'], undefined, wsB);
    const result = await agent.client.callTool({ name: 'artifacts.get', arguments: { artifactId: noteA } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_found');
  });

  it('refuses a brand whose role cannot grant the requested scopes', async () => {
    await expect(connectAgent(t.base, owner, ['artifacts:write'], undefined, wsC)).rejects.toThrow(/cannot grant/);
  });

  it('refuses an unbound connection when the person belongs to several brands', async () => {
    // A grant without a workspace claim (an old connection, or a direct consent without choosing)
    // is refused rather than silently acting in the person's first brand.
    expect(await principalFromAccessToken(t.srv.db, { sub: owner.id, scope: 'artifacts:read', client_id: 'unbound-client' })).toBeNull();
    const bound = await principalFromAccessToken(t.srv.db, {
      sub: owner.id,
      scope: 'artifacts:read',
      client_id: 'bound-client',
      workspace_id: wsB,
    });
    expect(bound).toMatchObject({ type: 'agent', workspaceId: wsB });
  });
});
