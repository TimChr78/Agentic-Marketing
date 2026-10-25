import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, rejects, startTestServer, type User } from './harness';

// Editable API tokens (#44) and the approval detail the review drawer needs (#41).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let viewer: User;
let ownerName: string;

beforeAll(async () => {
  t = await startTestServer('test_tokens02', 3402);
  owner = await t.signUp(`owner-tokens-${Date.now()}@example.com`);
  viewer = await t.signUp(`viewer-tokens-${Date.now()}@example.com`);
  ownerName = owner.email.split('@')[0];
  await t.workspaceWith(
    [
      [owner, 'owner'],
      [viewer, 'viewer'],
    ],
    'agent_changes',
  );
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const rest = (token: string, name: string, body: unknown) =>
  fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/** A tools/call without an MCP session, enough to exercise the endpoint's own token checks. */
const mcpCall = (token: string, name: string, args: unknown) =>
  fetch(`${t.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

async function tokenClient(token: string) {
  const client = new Client({ name: 'tokens-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((x) => x.name);
const structured = (r: any) => r.structuredContent as any;

const noteContent = (title: string, body: string) => ({ title, body });

describe('apiTokens.update', () => {
  it('renames, narrows at once over REST and MCP, then widens only with the password', async () => {
    const api = t.api(owner);
    const tok = await api.call('apiTokens.create', { name: 'n8n', scopes: ['artifacts:read', 'artifacts:write'] });
    expect(tok.ownerName).toBe(ownerName);
    const client = await tokenClient(tok.token);

    const renamed = await api.call('apiTokens.update', { id: tok.id, name: 'n8n renamed' });
    expect(renamed).toMatchObject({ name: 'n8n renamed', added: [], removed: [], steppedUp: false });
    expect((await api.call('apiTokens.list', {})).tokens.find((x) => x.id === tok.id)?.ownerName).toBe(ownerName);

    const narrowed = await api.call('apiTokens.update', { id: tok.id, scopes: ['artifacts:read'] });
    expect(narrowed).toMatchObject({ scopes: ['artifacts:read'], added: [], removed: ['artifacts:write'], steppedUp: false });

    // The next REST call and the next MCP tools/call both see the narrowed scopes.
    const deniedRest = await rest(tok.token, 'artifacts.create', { type: 'note', name: 'Denied', content: noteContent('x', 'y') });
    expect(deniedRest.status).toBe(403);
    const deniedMcp = await mcpCall(tok.token, 'artifacts.create', { type: 'note', name: 'Denied', content: noteContent('x', 'y') });
    expect(deniedMcp.status).toBe(200);
    const deniedBody = await deniedMcp.json();
    expect(deniedBody.result.isError).toBe(true);
    expect(deniedBody.result.content[0].text).toContain('artifacts:write');
    expect(await toolNames(client)).not.toContain('artifacts.create');

    const noPassword = await rejects(api.call('apiTokens.update', { id: tok.id, scopes: ['artifacts:read', 'artifacts:write'] }));
    expect(noPassword.status).toBe(403);
    expect(noPassword.message).toContain('artifacts:write');
    expect(noPassword.message).toContain('password');
    const wrong = await rejects(
      api.call('apiTokens.update', { id: tok.id, scopes: ['artifacts:read', 'artifacts:write'], password: 'not-the-password' }),
    );
    expect(wrong.status).toBe(403);
    expect(wrong.message).toBe('The password is not correct.');

    const widened = await api.call('apiTokens.update', {
      id: tok.id,
      scopes: ['artifacts:read', 'artifacts:write'],
      password: PASSWORD,
    });
    expect(widened).toMatchObject({ added: ['artifacts:write'], removed: [], steppedUp: true });
    expect((await rest(tok.token, 'artifacts.create', { type: 'note', name: 'Allowed', content: noteContent('x', 'y') })).status).toBe(200);
    const allowedMcp = await client.callTool({
      name: 'artifacts.create',
      arguments: { type: 'note', name: 'Allowed over MCP', content: noteContent('x', 'y') },
    });
    expect(allowedMcp.isError).toBeFalsy();
    expect(structured(allowedMcp).artifactId).toMatch(/^not_/);
    expect(await toolNames(client)).toContain('artifacts.create');
    await client.close();
  });

  it('never grants more than the token owner’s role allows', async () => {
    const viewerApi = t.api(viewer);
    const tok = await viewerApi.call('apiTokens.create', { name: 'viewer token', scopes: ['artifacts:read'] });
    const beyond = await rejects(t.api(owner).call('apiTokens.update', { id: tok.id, scopes: ['artifacts:read', 'artifacts:publish'] }));
    expect(beyond.status).toBe(403);
    expect(beyond.message).toContain('viewer');
    expect(beyond.message).toContain('artifacts:publish');

    const noFields = await rejects(t.api(owner).call('apiTokens.update', { id: tok.id }));
    expect(noFields.status).toBe(400);
    expect(noFields.message).toContain('name, scopes or expiresAt');

    await viewerApi.call('apiTokens.revoke', { id: tok.id });
    const revoked = await rejects(t.api(owner).call('apiTokens.update', { id: tok.id, name: 'too late' }));
    expect(revoked.status).toBe(409);
    expect(revoked.message).toContain('revoked');
  });

  it('cannot be called by an API token, even one with workspace:admin', async () => {
    const api = t.api(owner);
    const agent = await api.call('apiTokens.create', { name: 'admin agent', scopes: ['workspace:admin'] });
    const target = await api.call('apiTokens.create', { name: 'target', scopes: ['artifacts:read'] });
    const res = await rest(agent.token, 'apiTokens.update', { id: target.id, name: 'changed by agent' });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain('person');
  });

  it('shows the full change history with the names of who changed it', async () => {
    const api = t.api(owner);
    const tok = await api.call('apiTokens.create', { name: 'history token', scopes: ['artifacts:read'] });
    await api.call('apiTokens.update', { id: tok.id, name: 'history token 2' });
    await api.call('apiTokens.update', { id: tok.id, scopes: ['artifacts:read', 'artifacts:write'], password: PASSWORD });
    expect((await rest(tok.token, 'artifacts.list', {})).status).toBe(200);
    await api.call('apiTokens.revoke', { id: tok.id });

    const detail = await api.call('apiTokens.get', { id: tok.id });
    expect(detail).toMatchObject({
      id: tok.id,
      revoked: true,
      ownerName,
      owner: { id: owner.id, email: owner.email },
    });
    expect(detail.lastUsedAt).toBeTruthy();
    expect(detail.history).toHaveLength(4);
    expect(detail.history[0].changes).toEqual({ revoked: true });
    expect(detail.history[0].by).toEqual({ id: owner.id, name: ownerName });
    expect(detail.history[1].changes).toMatchObject({
      scopes: { from: ['artifacts:read'], to: ['artifacts:read', 'artifacts:write'] },
    });
    expect(detail.history[1].steppedUp).toBe(true);
    expect(detail.history[2].changes).toMatchObject({ name: { from: 'history token', to: 'history token 2' } });
    expect(detail.history[3].changes).toMatchObject({ created: { name: 'history token' } });
    for (const entry of detail.history) expect(entry.by.name).toBe(ownerName);

    const denied = await rejects(t.api(viewer).call('apiTokens.get', { id: tok.id }));
    expect(denied.status).toBe(404);
  });

  it('needs a password to extend or remove the expiry, but not to shorten it', async () => {
    const api = t.api(owner);
    const tok = await api.call('apiTokens.create', { name: 'expiring', scopes: ['artifacts:read'], expiresInDays: 10 });
    const extended = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const denied = await rejects(api.call('apiTokens.update', { id: tok.id, expiresAt: extended }));
    expect(denied.status).toBe(403);
    expect(denied.message).toContain('Extending');

    const allowed = await api.call('apiTokens.update', { id: tok.id, expiresAt: extended, password: PASSWORD });
    expect(allowed.steppedUp).toBe(true);
    const shortened = await api.call('apiTokens.update', { id: tok.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(shortened.steppedUp).toBe(false);
  });
});

describe('approval review data', () => {
  it('resolves the token requester and shows content, published content and diff', async () => {
    const api = t.api(owner);
    const tok = await api.call('apiTokens.create', {
      name: 'apply-script',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    });
    const created = await (
      await rest(tok.token, 'artifacts.create', { type: 'note', name: 'Agent note', content: noteContent('Version 1', 'First') })
    ).json();
    expect((await rest(tok.token, 'artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' })).status).toBe(200);

    const pending = (await api.call('approvals.list', {})).approvals.find((a) => a.artifactId === created.artifactId)!;
    expect(pending.requester).toEqual({
      kind: 'token',
      displayName: `apply-script (${ownerName})`,
      personName: ownerName,
      tokenName: 'apply-script',
      tokenId: tok.id,
      clientName: null,
    });
    expect(pending.requestedBy).toMatchObject({ type: 'agent', id: owner.id, client: `token:${tok.id}` });
    expect(pending).toMatchObject({ version: 1, artifactLatestVersion: 1, artifactPublishedVersion: null });
    await api.call('approvals.approve', { approvalId: pending.id });

    const updated = await (
      await rest(tok.token, 'artifacts.updateDraft', {
        artifactId: created.artifactId,
        content: noteContent('Version 2', 'Second'),
        note: 'v2',
      })
    ).json();
    expect(updated.version).toBe(2);
    expect((await rest(tok.token, 'artifacts.requestPublish', { artifactId: created.artifactId, note: 'v2' })).status).toBe(200);

    const filtered = await api.call('approvals.list', { artifactId: created.artifactId });
    expect(filtered.approvals).toHaveLength(1);
    const v2 = filtered.approvals[0];
    expect(v2).toMatchObject({ version: 2, artifactLatestVersion: 2, artifactPublishedVersion: 1 });

    const detail = await api.call('approvals.get', { approvalId: v2.id });
    expect(detail).toMatchObject({
      id: v2.id,
      version: 2,
      artifactPublishedVersion: 1,
      publishedVersion: 1,
      content: noteContent('Version 2', 'Second'),
      publishedContent: noteContent('Version 1', 'First'),
      history: [],
    });
    expect(detail.diff).toMatchObject({ from: 1, to: 2 });
    expect(detail.diff.changes).toContainEqual({ path: 'title', kind: 'changed', before: 'Version 1', after: 'Version 2' });
    expect(detail.diff.changes).toContainEqual({ path: 'body', kind: 'changed', before: 'First', after: 'Second' });
    expect(detail.requester.displayName).toBe(`apply-script (${ownerName})`);

    const approved = await api.call('approvals.get', { approvalId: pending.id });
    expect(approved.diff).toMatchObject({ from: 1, to: 1, changes: [] });
    expect(approved.history).toHaveLength(1);
    expect(approved.history[0]).toMatchObject({ by: { id: owner.id, name: ownerName }, status: 'approved', note: null });
  });
});
