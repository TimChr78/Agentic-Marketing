import { updateWorkspace } from '@agentic-marketing/artifacts';
import { agentPrincipal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, rejects, startTestServer, type User } from './harness';

// The v0.2 API contract: review-first publishing, strict/warn-first inputs, MCP output schemas,
// date-times with offsets, workspace time zone and the workspace switcher.

const PORT = 3401;
const PORT_VARIANTS = 3402;
const BASE = `http://localhost:${PORT}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let variants: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let variantOwner: User;
let ws: string;
let otherWs: string;
let otherWsName: string;
let agent: Awaited<ReturnType<typeof connectAgent>>;
let variantAgent: Awaited<ReturnType<typeof connectAgent>>;

const structured = (r: any) => r.structuredContent as any;
const toolError = (r: any) => JSON.parse(r.content[0].text);
const toolText = (r: any) => r.content[0].text as string;

beforeAll(async () => {
  t = await startTestServer('test_api02', PORT);
  variants = await startTestServer('test_api02b', PORT_VARIANTS, {
    STRICT_INPUTS: 'true',
    MCP_TEXT_CONTENT: 'summary',
    MCP_TOOL_NAME_STYLE: 'underscore',
  });
  owner = await t.signUp(`api02-owner-${Date.now()}@example.com`);
  approver = await t.signUp(`api02-approver-${Date.now()}@example.com`);
  variantOwner = await variants.signUp(`api02-variant-${Date.now()}@example.com`);
  ws = await t.workspaceWith(
    [
      [owner, 'owner'],
      [approver, 'approver'],
    ],
    'agent_changes',
  );
  otherWs = await t.workspaceWith([[owner, 'marketer']], 'none');
  otherWsName = (await t.api(owner, otherWs).call('workspace.get', {})).name;
  await variants.workspaceWith([[variantOwner, 'owner']], 'agent_changes');
  agent = await connectAgent(t.base, owner, [...ROLE_PERMISSIONS.owner]);
  variantAgent = await connectAgent(variants.base, variantOwner, [...ROLE_PERMISSIONS.owner]);
}, 120_000);

afterAll(async () => {
  await agent?.client.close();
  await variantAgent?.client.close();
  await variants?.close();
  await t?.close();
});

describe('workspace settings and membership', () => {
  it('reports the time zone and explains each permission under the approval policy', async () => {
    const api = t.api(owner, ws);
    const out = await api.call('workspace.get', {});
    expect(out.timeZone).toBe('UTC');
    expect(out.permissionsExplained.map((p) => p.permission)).toEqual(out.you.permissions);
    const publish = out.permissionsExplained.find((p) => p.permission === 'artifacts:publish');
    expect(publish?.meaning).toContain('Publishes your own edits directly');
    expect(publish?.meaning).toContain('agent');
  });

  it('lets an admin change the name and time zone, and rejects an invalid zone with an example', async () => {
    const api = t.api(owner, ws);
    const updated = await api.call('workspace.update', { name: 'Signal Studio', timeZone: 'Europe/Copenhagen' });
    expect(updated).toMatchObject({ id: ws, name: 'Signal Studio', timeZone: 'Europe/Copenhagen' });
    expect(await api.call('workspace.get', {})).toMatchObject({ name: 'Signal Studio', timeZone: 'Europe/Copenhagen' });

    const bad = await rejects(api.call('workspace.update', { timeZone: 'Mars/Olympus' }));
    expect(bad.status).toBe(400);
    expect(bad.message).toContain('Europe/Copenhagen');

    const notAdmin = await rejects(t.api(owner, otherWs).call('workspace.update', { name: 'Nope' }));
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.message).toContain('workspace:admin');
  });

  it('lists the signed-in person’s workspaces and switches with X-Workspace-Id', async () => {
    const api = t.api(owner, ws);
    const list = await api.call('workspace.memberships', {});
    expect(list.workspaces).toEqual(
      expect.arrayContaining([
        { id: ws, name: 'Signal Studio', role: 'owner' },
        { id: otherWs, name: otherWsName, role: 'marketer' },
      ]),
    );
    expect((await t.api(owner, otherWs).call('workspace.get', {})).id).toBe(otherWs);
  });

  it('keeps workspace.update people-only', async () => {
    const agentPrincipal = agentPrincipalForTest(owner.id, ws);
    const err = await rejects(t.srv.executor.execute(updateWorkspace, { name: 'Agent edit' }, agentPrincipal, { surface: 'mcp' }));
    expect(err.status).toBe(403);
    expect(err.message).toContain('can only be run by a person');
  });
});

function agentPrincipalForTest(userId: string, workspaceId: string) {
  return agentPrincipal(userId, 'test-client', workspaceId, 'owner', ['artifacts:read', 'workspace:admin']);
}

describe('review-first publishing', () => {
  it('publishes a person’s own edit directly and says so in next', async () => {
    const api = t.api(owner, ws);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'note',
      name: 'Person note',
      content: { title: 'Person note', body: 'Hello' },
    });
    const out = await api.call('artifacts.requestPublish', { artifactId, note: 'My own edit' });
    expect(out).toMatchObject({ status: 'published', reviewUrl: null });
    expect(out.next).toBe('Published as v1; it is live now.');
  });

  it('sends an agent’s change to review with a reviewUrl and next hint', async () => {
    const created = structured(
      await agent.client.callTool({
        name: 'artifacts.create',
        arguments: { type: 'note', name: 'Agent note', content: { title: 'Agent note', body: 'Hello' } },
      }),
    );
    const out = structured(
      await agent.client.callTool({
        name: 'artifacts.requestPublish',
        arguments: { artifactId: created.artifactId, note: 'Please review' },
      }),
    );
    expect(out).toMatchObject({ status: 'in_review', policy: 'agent_changes' });
    expect(out.reviewUrl).toBe(`${BASE}/approvals/${out.approvalId}`);
    expect(out.next).toContain(out.reviewUrl);

    const list = await t.api(owner, ws).call('approvals.list', {});
    expect(list.approvals.find((a) => a.id === out.approvalId)).toMatchObject({ reviewUrl: out.reviewUrl });
  });
});

describe('strict and warn-first unknown input keys', () => {
  it('accepts unknown REST keys with warnings by default', async () => {
    const out = (await t.api(owner, ws).call('workspace.get', { unexpected: true } as any)) as any;
    expect(out.warnings).toEqual(['Unknown input key "unexpected" for workspace.get. Allowed keys: (none).']);
  });

  it('appends warnings to a command result that already has string warnings', async () => {
    const out = (await t.api(owner, ws).call('emailProviders.create', {
      name: 'Log provider',
      adapter: 'log',
      fromEmail: 'from@example.com',
      unexpected: true,
    } as any)) as any;
    expect(out.warnings).toEqual([
      'Unknown input key "unexpected" for emailProviders.create. Allowed keys: name, adapter, config, secrets, fromEmail, fromName, replyTo, useFor.',
    ]);
  });

  it('rejects them on a strict server with the command and allowed keys', async () => {
    const err = await rejects(variants.api(variantOwner).call('workspace.get', { unexpected: true } as any));
    expect(err.status).toBe(400);
    expect(err.message).toBe('Unknown input key "unexpected" for workspace.get. Allowed keys: (none).');
    expect(err.details).toMatchObject({ unknownKeys: [{ path: 'unexpected', allowed: [] }] });
  });

  it('passes raw arguments through MCP so default servers warn and strict servers reject', async () => {
    const lenient = await agent.client.callTool({ name: 'workspace.get', arguments: { unexpected: true } });
    expect(lenient.isError).toBeFalsy();
    expect((structured(lenient) as any).warnings).toEqual(['Unknown input key "unexpected" for workspace.get. Allowed keys: (none).']);

    const strict = await variantAgent.client.callTool({ name: 'workspace_get', arguments: { unexpected: true } });
    expect(strict.isError).toBe(true);
    expect(toolError(strict)).toMatchObject({
      error: 'invalid_input',
      message: 'Unknown input key "unexpected" for workspace.get. Allowed keys: (none).',
    });
  });
});

describe('MCP output schemas and text', () => {
  it('advertises an object output schema for every tool', async () => {
    const tools = (await agent.client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
  });

  it('keeps full JSON text by default and structuredContent identical to it', async () => {
    const res = await agent.client.callTool({ name: 'workspace.get', arguments: {} });
    expect(JSON.parse(toolText(res))).toEqual(res.structuredContent);
  });

  it('offers underscore tool names and one-line summaries on the variants server', async () => {
    const tools = (await variantAgent.client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toContain('artifacts_list');
    expect(tools.every((tool) => !tool.name.includes('.'))).toBe(true);

    const res = await variantAgent.client.callTool({ name: 'workspace_get', arguments: {} });
    expect(toolText(res)).toMatch(/^workspace\.get: id=/);
    expect(toolText(res)).not.toContain('\n');
    expect((structured(res) as any).id).toBeTruthy();
  });

  it('answers a scope step-up for an underscore tool name', async () => {
    const limited = await connectAgent(variants.base, variantOwner, ['artifacts:read']);
    try {
      const token = (limited.provider.tokens() as { access_token: string }).access_token;
      const response = await fetch(`${variants.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'artifacts_create',
            arguments: { type: 'note', name: 'x', content: { title: 'x', body: 'x' } },
          },
        }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    } finally {
      await limited.client.close();
    }
  }, 30_000);
});

describe('date-times with offsets', () => {
  it('accepts an offset and stores and returns UTC', async () => {
    const api = t.api(owner, ws);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'broadcast',
      name: 'Offset broadcast',
      content: {
        template: `eml_${'0'.repeat(32)}`,
        segment: `seg_${'0'.repeat(32)}`,
        sendAt: '2026-10-24T15:00:00+02:00',
      },
    });
    const got = await api.call('artifacts.get', { artifactId });
    expect((got.version.content as { sendAt: string }).sendAt).toBe('2026-10-24T13:00:00.000Z');
  });

  it('rejects a date-time without a zone, naming the field', async () => {
    const err = await rejects(
      t.api(owner, ws).call('artifacts.create', {
        type: 'broadcast',
        name: 'Zone-less broadcast',
        content: {
          template: `eml_${'0'.repeat(32)}`,
          segment: `seg_${'0'.repeat(32)}`,
          sendAt: '2026-10-24T15:00:00',
        },
      }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('sendAt needs a time zone, e.g. 2026-10-30T07:00:00Z or 2026-10-30T09:00:00+02:00.');
  });
});
