import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 17 (ADR-0016): agents as principals with a pause button (#213), workspace
// autonomy settings (#215), the policy engine (#216) with the audience threshold and per-agent
// limits the docs promised (#217), and the action ledger (#218).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';
let segmentId = '';
let templateId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';

beforeAll(async () => {
  t = await startTestServer('test_agents', testPort(3476));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // Policy `none`: today agents publish directly; the engine's limits must still apply.
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
  const tpl = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Issue',
    content: { purpose: 'marketing_email', subject: 'This week', mjml },
  });
  await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
  templateId = tpl.artifactId;
  await api.call('profiles.import', {
    label: 'Agents test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Everyone',
    content: { condition: { consent: 'marketing_email' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
  segmentId = seg.artifactId;
  await eventually(
    () => api.call('segments.refresh', { artifactId: segmentId }),
    (r) => r.members === 3,
  );
  token = (
    await api.call('apiTokens.create', {
      name: 'Hermes',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send', 'audit:read'],
    })
  ).token;
}, 90_000);
afterAll(() => t?.close());

const call = async (name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const setAutonomy = (settings: Record<string, unknown>) => t.api(owner).call('workspace.setAutonomy', settings as never);
const draftBroadcast = async () =>
  (
    await call('artifacts.create', {
      type: 'broadcast',
      name: `Issue ${Date.now()}`,
      content: { template: templateId, segment: segmentId },
    })
  ).body.artifactId as string;

describe('agents as principals (#213)', () => {
  it('an API token becomes an agent on first use, with its creator as sponsor', async () => {
    const me = await call('agents.get');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: 'Hermes', status: 'active', sponsor: { id: owner.id }, brand: null });
    expect(me.body.credentials).toMatchObject([{ kind: 'api_token' }]);
    const list = await t.api(owner).call('agents.list', {});
    expect(list.agents.map((a) => a.name)).toContain('Hermes');
  });

  it('a connected MCP client becomes an agent too', async () => {
    const agent = await connectAgent(t.base, owner, ['artifacts:read']);
    await agent.client.callTool({ name: 'agents.get', arguments: {} });
    const list = await t.api(owner).call('agents.list', {});
    expect(list.agents.find((a) => a.credentials.some((c) => c.kind === 'oauth_client' && c.id === agent.clientId))).toBeTruthy();
  });

  it('pausing stops every request at once; resuming lets it work again', async () => {
    const me = (await call('agents.get')).body;
    await t.api(owner).call('agents.pause', { id: me.id, reason: 'Checking last week’s send' });
    const refused = await call('agents.get');
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('Hermes) is paused: Checking last week’s send');
    await t.api(owner).call('agents.resume', { id: me.id });
    expect((await call('agents.get')).status).toBe(200);
  });

  it('a paused agent’s pending change cannot be approved, but can be rejected', async () => {
    await setAutonomy({ switch: 'propose_only' });
    const tpl = await call('artifacts.create', {
      type: 'email_template',
      name: 'Held',
      content: { purpose: 'marketing_email', subject: 'Held', mjml },
    });
    const held = await call('artifacts.requestPublish', { artifactId: tpl.body.artifactId, note: 'please review' });
    expect(held.body.status).toBe('in_review');
    const me = (await call('agents.get')).body;
    await t.api(owner).call('agents.pause', { id: me.id });
    await expect(t.api(owner).call('approvals.approve', { approvalId: held.body.approvalId })).rejects.toMatchObject({
      message: expect.stringContaining('which is paused'),
    });
    await t.api(owner).call('approvals.reject', { approvalId: held.body.approvalId, note: 'not now' });
    await t.api(owner).call('agents.resume', { id: me.id });
    await setAutonomy({ switch: 'on' });
  });

  it('agents cannot change their own status or the workspace’s limits', async () => {
    const me = (await call('agents.get')).body;
    expect((await call('agents.resume', { id: me.id })).status).toBe(403);
    expect((await call('workspace.setAutonomy', { switch: 'on' })).status).toBe(403);
    expect((await call('workspace.autonomy')).body).toMatchObject({ switch: 'on', audienceThreshold: 1000 });
  });
});

describe('the policy engine (#215–#217)', () => {
  it('a broadcast above the audience threshold waits for a person, even under policy `none`', async () => {
    await setAutonomy({ audienceThreshold: 2 });
    const held = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(), note: 'weekly issue' });
    expect(held.status).toBe(200);
    expect(held.body.status).toBe('in_review');
    expect(held.body.heldBecause[0]).toContain('reaches 3 people, above the workspace’s threshold of 2');
    const approval = (await t.api(owner).call('approvals.list', {})).approvals.find((a: any) => a.id === held.body.approvalId);
    expect(approval?.note).toContain('Needs a person');
  });

  it('a broadcast within the threshold publishes directly, as the approval policy allows', async () => {
    await setAutonomy({ audienceThreshold: 10 });
    const out = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(), note: 'weekly issue' });
    expect(out.body.status).toBe('published');
    expect(out.body.heldBecause).toBeUndefined();
  });

  it('propose-only lets agents draft, sends publishing to a person and refuses the rest', async () => {
    await setAutonomy({ switch: 'propose_only' });
    const tpl = await call('artifacts.create', {
      type: 'email_template',
      name: 'Proposal',
      content: { purpose: 'marketing_email', subject: 'P', mjml },
    });
    expect(tpl.status).toBe(200);
    expect((await call('artifacts.requestPublish', { artifactId: tpl.body.artifactId, note: 'n' })).body.status).toBe('in_review');
    const refused = await call('segments.refresh', { artifactId: segmentId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('propose-only');
    await setAutonomy({ switch: 'on' });
  });

  it('off leaves agents read-only', async () => {
    await setAutonomy({ switch: 'off' });
    expect((await call('artifacts.create', { type: 'note', name: 'x', content: { title: 'x', body: 'x' } })).status).toBe(403);
    expect((await call('agents.get')).status).toBe(200);
    await setAutonomy({ switch: 'on' });
  });

  it('the daily change limit sends further changes to a person', async () => {
    const { last24h } = (await call('agents.get')).body;
    await setAutonomy({ limits: { changesPerDay: last24h.changes } });
    const tpl = await call('artifacts.create', {
      type: 'email_template',
      name: 'Over',
      content: { purpose: 'marketing_email', subject: 'O', mjml },
    });
    const out = await call('artifacts.requestPublish', { artifactId: tpl.body.artifactId, note: 'n' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause[0]).toContain('changes in the last 24 hours');
    await setAutonomy({ limits: { changesPerDay: 500 } });
  });
});

describe('the action ledger (#218)', () => {
  it('records every agent write with its decision, reasons and impact', async () => {
    const me = (await call('agents.get')).body;
    const { actions } = await t.api(owner).call('agents.activity', { agentId: me.id, limit: 100 });
    const held = actions.find((a) => a.decision === 'ask' && a.actionClass === 'send.broadcast');
    expect(held).toMatchObject({ command: 'artifacts.requestPublish', ok: true, impact: { people: 3, reversible: false } });
    const denied = actions.find((a) => a.decision === 'deny' && a.command === 'segments.refresh');
    expect(denied).toMatchObject({
      ok: false,
      actionClass: 'audience.publish',
      reasons: [expect.stringContaining('propose-only'), expect.any(String)],
    });
    expect(actions.find((a) => a.decision === 'deny' && a.command === 'artifacts.create')).toMatchObject({
      actionClass: 'draft',
      ok: false,
    });
    expect(actions.some((a) => a.decision === 'allow' && a.actionClass === 'draft')).toBe(true);
    expect(ws).toBeTruthy();
  });
});
