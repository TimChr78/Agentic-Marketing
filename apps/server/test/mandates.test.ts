import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import { getAgent } from '@agentic-marketing/auth';
import { agentPolicy, agentPrincipal } from '@agentic-marketing/commands';
import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHoldsOnce } from '../src/agents/holds';
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

describe('audit fixes (#260, #262, #263, #267, #268)', () => {
  let n = 0;
  /** A fresh agent with its own mandate, so earlier sends do not count against its limits. */
  async function freshAgent(content: Record<string, unknown>) {
    const api = t.api(owner);
    const tok = (
      await api.call('apiTokens.create', {
        name: `Audit agent ${++n}`,
        scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
      })
    ).token;
    const as = async (name: string, body: unknown = {}) => {
      const res = await fetch(`${t.base}/v1/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const id = (await as('agents.get')).body.id as string;
    const m = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: `Audit mandate ${n}`,
      content: { agent: id, purpose: 'Send the weekly newsletter', validUntil: inDays(30), ...content } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: m.artifactId, note: 'grant' })).status).toBe('published');
    const draft = async () =>
      (
        await as('artifacts.create', {
          type: 'broadcast',
          name: `Audit ${Date.now()}-${Math.random()}`,
          content: { template: templateId, segment: news },
        })
      ).body.artifactId as string;
    return { as, id, mandate: m.artifactId as string, draft };
  }
  const scope = () => ({ ...newsletterScope, segments: [news] });
  const due = (approvalId: string) =>
    t.srv.db.admin.query(`UPDATE approval_requests SET hold_until = now() - interval '1 second' WHERE id = $1`, [approvalId]);
  const approval = async (approvalId: string) =>
    (await t.srv.db.admin.query('SELECT status, hold_until, note FROM approval_requests WHERE id = $1', [approvalId])).rows[0];

  it('drafts skip the independent check; what runs by itself is checked and fails closed (#260)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 3 }, independentCheck: true });
    const id = await a.draft();
    expect(id).toMatch(/^bct_/);
    const out = await a.as('artifacts.requestPublish', { artifactId: id, note: 'checked' });
    expect(out.body.status).toBe('in_review');
  });

  it('a held send is decided again: a stricter mandate sends it to a person (#262)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 2 } });
    const id = await a.draft();
    const held = await a.as('artifacts.requestPublish', { artifactId: id, note: 'held' });
    expect(held.body.status).toBe('on_hold');
    await grant({ agent: a.id, scope: scope(), levels: { 'send.broadcast': 1 } }, a.mandate);
    await due(held.body.approvalId);
    const row = await eventually(
      () => approval(held.body.approvalId),
      (r) => r.hold_until === null,
    );
    expect(row.status).toBe('pending');
    expect(row.note).toContain('the mandate no longer allows it');
    expect((await t.api(owner).call('artifacts.get', { artifactId: id })).publishedVersion).toBeNull();
  });

  it('a held send outside working hours waits for the next opening (#262)', async () => {
    const hh = (h: number) => `${String((new Date().getUTCHours() + h) % 24).padStart(2, '0')}:00`;
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 3 }, workingHours: { start: hh(3), end: hh(4) } });
    const id = await a.draft();
    const held = await a.as('artifacts.requestPublish', { artifactId: id, note: 'after hours' });
    expect(held.body.status).toBe('on_hold');
    await due(held.body.approvalId);
    const row = await eventually(
      () => approval(held.body.approvalId),
      (r) => r.hold_until !== null && new Date(r.hold_until) > new Date(),
    );
    expect(row.status).toBe('pending');
    expect((await t.api(owner).call('artifacts.get', { artifactId: id })).publishedVersion).toBeNull();
  });

  it('two runners publish a due hold once; a veto racing the runner either wins or is refused (#263)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 2 } });
    const id = await a.draft();
    const held = await a.as('artifacts.requestPublish', { artifactId: id, note: 'race' });
    await due(held.body.approvalId);
    const deps = { db: t.srv.db, services: t.srv.services };
    await Promise.all([runHoldsOnce(deps), runHoldsOnce(deps), runHoldsOnce(deps)]);
    await eventually(
      () => approval(held.body.approvalId),
      (r) => r.status === 'approved',
    );
    const { rows } = await t.srv.db.admin.query(
      `SELECT count(*)::int AS n FROM agent_actions WHERE agent_id = $1 AND decision = 'allow' AND target = $2`,
      [a.id, id],
    );
    expect(rows[0].n).toBe(1);

    const id2 = await a.draft();
    const held2 = await a.as('artifacts.requestPublish', { artifactId: id2, note: 'race 2' });
    await due(held2.body.approvalId);
    const [veto] = await Promise.allSettled([
      t.api(owner).call('approvals.reject', { approvalId: held2.body.approvalId, note: 'No' }),
      runHoldsOnce(deps),
    ]);
    const final = await eventually(
      () => approval(held2.body.approvalId),
      (r) => r.status !== 'pending',
    );
    const published = (await t.api(owner).call('artifacts.get', { artifactId: id2 })).publishedVersion !== null;
    expect(final.status === 'rejected').toBe(!published);
    expect(veto.status === 'fulfilled').toBe(final.status === 'rejected');
  });

  it('limits count holds while they are due and forget vetoed ones (#267)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 2 }, limits: { sendsPerDay: 1 } });
    const first = await a.as('artifacts.requestPublish', { artifactId: await a.draft(), note: 'one' });
    expect(first.body.status).toBe('on_hold');
    // The pending hold counts: a second send passes the daily limit and drops to a person.
    expect((await a.as('artifacts.requestPublish', { artifactId: await a.draft(), note: 'two' })).body.status).toBe('in_review');
    await t.api(owner).call('approvals.reject', { approvalId: first.body.approvalId, note: 'Vetoed' });
    // Vetoed, it never ran: the limit is free again.
    expect((await a.as('artifacts.requestPublish', { artifactId: await a.draft(), note: 'three' })).body.status).toBe('on_hold');
  });

  it('a mandated agent imports a bundle; each publish is decided by its mandate (#268)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 } });
    const id = newId('not');
    const bundle = {
      format: 'agentic-marketing/artifacts@1',
      artifacts: [{ id, type: 'note', name: 'Imported note', content: { title: 'Imported', body: 'From a bundle.' } }],
    };
    const dry = await a.as('config.import', { bundle });
    expect(dry.status).toBe(200);
    const out = await a.as('config.import', { bundle, dryRun: false, publish: true, note: 'Import' });
    expect(out.status).toBe(200);
    expect(out.body.changes[0]).toMatchObject({ id, publish: 'published' });
  });

  it('a paused agent is stopped at its next command, even with a principal resolved before (#275)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 } });
    // A principal resolved while the agent was active, as a hosted run holds for its whole run.
    const stale = {
      ...agentPrincipal(owner.id, 'hosted:stale', ws, 'owner', ['artifacts:read', 'artifacts:write']),
      agent: { id: a.id, name: 'Stale', status: 'active' as const, statusReason: null },
    };
    expect(await t.srv.executor.execute(getAgent, { id: a.id }, stale, { surface: 'mcp' })).toMatchObject({ id: a.id });
    await t.api(owner).call('agents.pause', { id: a.id, reason: 'Stop now' });
    await expect(t.srv.executor.execute(getAgent, { id: a.id }, stale, { surface: 'mcp' })).rejects.toMatchObject({
      message: expect.stringContaining('is paused: Stop now'),
    });
  });

  it('undo refuses when newer work went live after the action (#281)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 } });
    const note = (await a.as('artifacts.create', { type: 'note', name: 'Undo me', content: { title: 'v1', body: 'one' } })).body.artifactId;
    expect((await a.as('artifacts.requestPublish', { artifactId: note, note: 'first' })).body.status).toBe('published');
    const { actions } = await t.api(owner).call('agents.activity', { agentId: a.id, limit: 1 });
    // A person publishes v2 after the agent's first publish.
    await t.api(owner).call('artifacts.updateDraft', { artifactId: note, content: { title: 'v2', body: 'two' } as never });
    await t.api(owner).call('artifacts.requestPublish', { artifactId: note, note: 'person' });
    await expect(t.api(owner).call('agents.undo', { actionId: actions[0].id })).rejects.toMatchObject({
      message: expect.stringContaining('v2 was published after this action'),
    });
    expect((await t.api(owner).call('artifacts.get', { artifactId: note })).publishedVersion).toBe(2);
  });

  it('a held change that needs a person after its window is recorded for the sponsor (#282)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'send.broadcast': 2 } });
    const held = await a.as('artifacts.requestPublish', { artifactId: await a.draft(), note: 'held' });
    await grant({ agent: a.id, scope: scope(), levels: { 'send.broadcast': 1 } }, a.mandate);
    await due(held.body.approvalId);
    const entry = await eventually(
      async () => (await t.api(owner).call('agents.activity', { agentId: a.id, limit: 1 })).actions[0],
      (x) => x.command === 'artifacts.heldRecheck',
    );
    expect(entry).toMatchObject({ decision: 'ask' });
    expect(entry.reasons[0]).toContain('A person decides');
  });

  it('the shadow report counts the approval each action created, not a neighbour’s (#286)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 }, shadow: true });
    const note = (await a.as('artifacts.create', { type: 'note', name: 'Shadowed', content: { title: 'a', body: 'a' } })).body.artifactId;
    const first = await a.as('artifacts.requestPublish', { artifactId: note, note: 'one' });
    expect(first.body.status).toBe('in_review');
    await t.api(owner).call('approvals.reject', { approvalId: first.body.approvalId, note: 'No' });
    await a.as('artifacts.updateDraft', { artifactId: note, content: { title: 'b', body: 'b' } });
    const second = await a.as('artifacts.requestPublish', { artifactId: note, note: 'two' });
    await t.api(owner).call('approvals.approve', { approvalId: second.body.approvalId });
    const report = await t.api(owner).call('agents.shadowReport', { agentId: a.id });
    expect(report.summary).toMatchObject({ total: 2, agree: 1, tooBold: 1 });
  });

  it('an undo record from before 0.5.2 is refused rather than guessed (#291)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 } });
    const note = (await a.as('artifacts.create', { type: 'note', name: 'Legacy undo', content: { title: 'v1', body: 'one' } })).body
      .artifactId;
    expect((await a.as('artifacts.requestPublish', { artifactId: note, note: 'first' })).body.status).toBe('published');
    const { actions } = await t.api(owner).call('agents.activity', { agentId: a.id, limit: 1 });
    // As 0.5.0/0.5.1 recorded it: no publishedVersion.
    await t.srv.db.admin.query(`UPDATE agent_actions SET undo = undo - 'publishedVersion' WHERE id = $1`, [actions[0].id]);
    // Not advertised as undoable either (#301).
    const listed = (await t.api(owner).call('agents.activity', { agentId: a.id, limit: 1 })).actions[0];
    expect(listed.undoable).toBe(false);
    await expect(t.api(owner).call('agents.undo', { actionId: actions[0].id })).rejects.toMatchObject({
      message: expect.stringContaining('recorded before undo knew which version'),
    });
    expect((await t.api(owner).call('artifacts.get', { artifactId: note })).publishedVersion).toBe(1);
  });

  it('every policy decision sees a pause, including those inside one long command (#292)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 } });
    const principal = {
      ...agentPrincipal(owner.id, 'hosted:import', ws, 'owner', ['artifacts:read', 'artifacts:write', 'artifacts:publish']),
      agent: { id: a.id, name: 'Importer', status: 'active' as const, statusReason: null },
    };
    await t.api(owner).call('agents.pause', { id: a.id, reason: 'Mid-import' });
    await expect(
      t.srv.db.withWorkspace(ws, (tx) =>
        agentPolicy(tx, t.srv.services, principal, {
          command: 'artifacts.requestPublish',
          actionClass: 'content.publish',
          impact: {},
          approvable: true,
          input: {},
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('is paused: Mid-import') });
  });

  it('config.import records the approvals it creates, so the shadow report sees them (#293)', async () => {
    const a = await freshAgent({ scope: scope(), levels: { 'content.publish': 3 }, shadow: true });
    const id = newId('not');
    const out = await a.as('config.import', {
      bundle: {
        format: 'agentic-marketing/artifacts@1',
        artifacts: [{ id, type: 'note', name: 'Shadow import', content: { title: 'Imported', body: 'From a bundle.' } }],
      },
      dryRun: false,
      publish: true,
      note: 'Import',
    });
    expect(out.body.changes[0]).toMatchObject({ id, publish: 'in_review' });
    const { approvals } = await t.api(owner).call('approvals.list', {});
    const approval = approvals.find((x) => x.artifactId === id);
    await t.api(owner).call('approvals.approve', { approvalId: approval!.id });
    const report = await t.api(owner).call('agents.shadowReport', { agentId: a.id });
    expect(report.summary).toMatchObject({ total: 1, agree: 1 });
  });
});
