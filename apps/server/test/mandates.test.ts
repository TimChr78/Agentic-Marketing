import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 18 (ADR-0016): mandates (#223), autonomy levels with scope, limits, guardrails and
// intents (#224), holds with veto windows (#225), the same for any agent runtime (#229).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';
let agentId = '';
let news = '';
let other = '';
let templateId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  t = await startTestServer('test_mandates', testPort(3475));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // agent_changes: without a mandate, every agent publish waits for a person.
  ws = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
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
    label: 'Mandates test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  for (const [name, set] of [
    ['News', (id: string) => (news = id)],
    ['Other', (id: string) => (other = id)],
  ] as const) {
    const seg = await api.call('artifacts.create', { type: 'segment', name, content: { condition: { consent: 'marketing_email' } } });
    await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
    set(seg.artifactId);
    await eventually(
      () => api.call('segments.refresh', { artifactId: seg.artifactId }),
      (r) => r.members === 3,
    );
  }
  token = (
    await api.call('apiTokens.create', {
      name: 'Newsletter agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
}, 90_000);
afterAll(() => t?.close());

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** A person publishes a mandate for an agent (a new version when `id` is given). */
async function grant(content: Record<string, unknown>, id?: string) {
  const api = t.api(owner);
  const full = { agent: agentId, purpose: 'Send the weekly newsletter', validUntil: inDays(30), ...content };
  const artifactId = id
    ? (await api.call('artifacts.updateDraft', { artifactId: id, content: full as never })).artifactId
    : (await api.call('artifacts.create', { type: 'agent_mandate', name: 'Newsletter mandate', content: full as never })).artifactId;
  const out = await api.call('artifacts.requestPublish', { artifactId, note: 'grant' });
  expect(out.status).toBe('published');
  return artifactId;
}

const newsletterScope = { segments: [] as string[], purposes: ['marketing_email'], channels: ['email'] };
const draftBroadcast = async (segment: string) =>
  (await call('artifacts.create', { type: 'broadcast', name: `Issue ${Date.now()}`, content: { template: templateId, segment } })).body
    .artifactId as string;

let mandateId = '';

describe('mandates are set by people (#223)', () => {
  it('an agent cannot create its own mandate', async () => {
    const out = await call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Mine',
      content: { agent: agentId, purpose: 'x', validUntil: inDays(30), levels: { 'send.broadcast': 3 } },
    });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('agents cannot set their own borders');
  });

  it('a level above the workspace ceiling cannot be published', async () => {
    const api = t.api(owner);
    const a = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Too much',
      content: { agent: agentId, purpose: 'x', validUntil: inDays(30), levels: { 'journey.live': 3 } } as never,
    });
    await expect(api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('above the workspace ceiling of 1'),
    });
  });

  it('without a mandate the approval policy decides, as before', async () => {
    const out = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(news), note: 'issue 1' });
    expect(out.body.status).toBe('in_review');
  });
});

describe('autonomy levels (#224) and holds (#225)', () => {
  it('level 3 publishes the broadcast itself, inside the scope', async () => {
    mandateId = await grant({ scope: { ...newsletterScope, segments: [news] }, levels: { 'send.broadcast': 3, 'content.publish': 3 } });
    const id = await draftBroadcast(news);
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Issue 2 to the newsletter readers' });
    expect(out.body.status).toBe('published');
    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 5 });
    expect(actions[0]).toMatchObject({
      decision: 'allow',
      actionClass: 'send.broadcast',
      mandateId,
      mandateVersion: 1,
      intent: 'Issue 2 to the newsletter readers',
      impact: { people: 3 },
    });
  });

  it('outside the scope it only proposes, with the reason', async () => {
    const out = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(other), note: 'wrong audience' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain(`Audience ${other} is outside this agent’s mandate`);
  });

  it('a mandate limit drops level 3 to a hold, which runs after its veto window', async () => {
    await grant(
      { scope: { ...newsletterScope, segments: [news] }, levels: { 'send.broadcast': 3 }, limits: { recipientsPerSend: 2 } },
      mandateId,
    );
    const id = await draftBroadcast(news);
    const held = await call('artifacts.requestPublish', { artifactId: id, note: 'Issue 3' });
    expect(held.body).toMatchObject({ status: 'on_hold' });
    expect(held.body.runsAt).toBeTruthy();
    expect(held.body.heldBecause.join(' ')).toContain('the mandate allows 2 per send');
    // The veto window ends without a veto.
    await t.srv.db.admin.query(`UPDATE approval_requests SET hold_until = now() - interval '1 second' WHERE id = $1`, [
      held.body.approvalId,
    ]);
    const done = await eventually(
      () => t.api(owner).call('artifacts.get', { artifactId: id }),
      (a) => a.publishedVersion !== null,
    );
    expect(done.publishedVersion).toBe(held.body.version);
    const { rows } = await t.srv.db.admin.query('SELECT status, decided_by FROM approval_requests WHERE id = $1', [held.body.approvalId]);
    expect(rows[0]).toEqual({ status: 'approved', decided_by: 'policy:hold' });
  });

  it('a person can veto a hold before it runs', async () => {
    const id = await draftBroadcast(news);
    const held = await call('artifacts.requestPublish', { artifactId: id, note: 'Issue 4' });
    expect(held.body.status).toBe('on_hold');
    await t.api(owner).call('approvals.reject', { approvalId: held.body.approvalId, note: 'Not this week' });
    await t.srv.db.admin.query(`UPDATE approval_requests SET hold_until = now() - interval '1 second' WHERE id = $1`, [
      held.body.approvalId,
    ]);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await t.api(owner).call('artifacts.get', { artifactId: id })).publishedVersion).toBeNull();
  });

  it('a hold whose agent was paused meanwhile becomes an ordinary approval', async () => {
    const id = await draftBroadcast(news);
    const held = await call('artifacts.requestPublish', { artifactId: id, note: 'Issue 5' });
    await t.api(owner).call('agents.pause', { id: agentId, reason: 'Checking' });
    await t.srv.db.admin.query(`UPDATE approval_requests SET hold_until = now() - interval '1 second' WHERE id = $1`, [
      held.body.approvalId,
    ]);
    const row = await eventually(
      async () =>
        (await t.srv.db.admin.query('SELECT status, hold_until, note FROM approval_requests WHERE id = $1', [held.body.approvalId]))
          .rows[0],
      (r) => r.hold_until === null,
    );
    expect(row.status).toBe('pending');
    expect(row.note).toContain('is paused');
    await t.api(owner).call('agents.resume', { id: agentId });
  });

  it('a guardrail breach on the agent’s own sends goes to a person', async () => {
    await grant(
      {
        scope: { ...newsletterScope, segments: [news] },
        levels: { 'send.broadcast': 3 },
        guardrails: { unsubscribeRate: 0.1, window: 'P7D', minSent: 1 },
      },
      mandateId,
    );
    // The agent's level-3 send of issue 2 reached three people; two of them unsubscribe.
    const { actions } = await t.api(owner).call('agents.activity', { agentId, decision: 'allow', actionClass: 'send.broadcast', limit: 1 });
    const broadcastId = actions.at(-1)!.target!;
    const sent = await eventually(
      async () => (await t.srv.db.admin.query('SELECT id, profile_id FROM messages WHERE journey_id = $1', [broadcastId])).rows,
      (r) => r.length === 3,
    );
    await t.srv.events.insertMessageEvents(
      sent.slice(0, 2).map((m: { id: string; profile_id: string }) => ({
        workspaceId: ws,
        messageId: m.id,
        eventId: `unsub:${m.id}`,
        type: 'unsubscribed' as const,
        at: new Date().toISOString(),
        profileId: m.profile_id,
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId,
        templateVersion: 1,
        journeyId: broadcastId,
        reason: '',
        url: '',
      })),
    );
    // ClickHouse stores events asynchronously: wait until the metric layer sees both, then ask once.
    await eventually(
      async () => {
        clearAnalyticsCache();
        return t.api(owner).call('analytics.query', {
          measures: ['email.unsubscribed'],
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date(Date.now() + 60_000).toISOString(),
          filters: { broadcast: [broadcastId] },
        });
      },
      (r) => r.rows[0]?.[0] === 2,
      20_000,
    );
    clearAnalyticsCache();
    const out = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(news), note: 'Issue 6' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toMatch(/unsubscribe rate of .*above its mandate’s guardrail of 10%/);
  });

  it('an expired mandate stops applying', async () => {
    await t.srv.db.admin.query(
      `UPDATE artifact_versions SET content = jsonb_set(content, '{validUntil}', to_jsonb($2::text)) WHERE artifact_id = $1`,
      [mandateId, new Date(Date.now() - 60_000).toISOString()],
    );
    const out = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(news), note: 'after expiry' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause).toBeUndefined();
  });
});

describe('any agent runtime (#229)', () => {
  it('an MCP client under a mandate is decided the same way as an API token', async () => {
    const agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    const me = (await agent.client.callTool({ name: 'agents.get', arguments: {} })) as { structuredContent: { id: string } };
    const mcpAgent = me.structuredContent.id;
    const api = t.api(owner);
    const m = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'MCP mandate',
      content: {
        agent: mcpAgent,
        purpose: 'Send the weekly newsletter',
        validUntil: inDays(30),
        scope: { ...newsletterScope, segments: [news] },
        levels: { 'send.broadcast': 3, 'content.publish': 3 },
      } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: m.artifactId, note: 'grant' })).status).toBe('published');
    const created = (await agent.client.callTool({
      name: 'artifacts.create',
      arguments: { type: 'broadcast', name: 'MCP issue', content: { template: templateId, segment: news } },
    })) as { structuredContent: { artifactId: string } };
    const out = (await agent.client.callTool({
      name: 'artifacts.requestPublish',
      arguments: { artifactId: created.structuredContent.artifactId, note: 'Issue from an MCP client' },
    })) as { structuredContent: { status: string } };
    expect(out.structuredContent.status).toBe('published');
  });
});

describe('learning rules (#257)', () => {
  it('a broadcast without a holdout or subject test goes to a person; with a subject test it runs', async () => {
    await grant(
      {
        scope: { ...newsletterScope, segments: [news] },
        levels: { 'send.broadcast': 3, 'content.publish': 3 },
        learning: { broadcastHoldout: true },
      },
      mandateId,
    );
    const plain = await call('artifacts.requestPublish', { artifactId: await draftBroadcast(news), note: 'no holdout' });
    expect(plain.body.status).toBe('in_review');
    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 1 });
    expect(actions[0].reasons.join(' ')).toContain('neither a holdout');

    const tested = await call('artifacts.create', {
      type: 'broadcast',
      name: `Tested ${Date.now()}`,
      content: {
        template: templateId,
        segment: news,
        subjectTest: { subjects: ['A', 'B'], samplePercent: 50, decideAfter: 'PT4H' },
      },
    });
    const out = await call('artifacts.requestPublish', { artifactId: tested.body.artifactId, note: 'with a subject test' });
    expect(out.body.status).toBe('published');
  });
});
