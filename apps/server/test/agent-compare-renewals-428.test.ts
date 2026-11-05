import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import type { Permission } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Phase 22 (#428): compare agents side by side, renew mandates in one call, and put ad audiences
// and conversions under a mandate's `ads` channel.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';

interface Agent {
  token: string;
  agentId: string;
}

beforeAll(async () => {
  t = await startTestServer('test_agent_compare_428', testPort(4280));
  owner = await t.signUp(`owner-compare-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

async function agentCall(token: string, name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function makeAgent(api: ReturnType<typeof t.api>, name: string, scopes: Permission[]): Promise<Agent> {
  const { token } = await api.call('apiTokens.create', { name, scopes });
  const me = await agentCall(token, 'agents.get');
  expect(me.status).toBe(200);
  return { token, agentId: me.body.id as string };
}

async function grantMandate(
  api: ReturnType<typeof t.api>,
  agentId: string,
  name: string,
  content: Record<string, unknown>,
): Promise<string> {
  const created = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name,
    content: { agent: agentId, purpose: 'Act for this workspace', validUntil: inDays(30), ...content } as never,
  });
  const published = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'grant' });
  expect(published.status).toBe('published');
  return created.artifactId;
}

const draftBroadcast = async (token: string, name: string, template: string, segment: string) =>
  (
    await agentCall(token, 'artifacts.create', {
      type: 'broadcast',
      name,
      content: { template, segment },
    })
  ).body.artifactId as string;

describe('agents.compare (#428)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let a: Agent;
  let b: Agent;
  let mandateA = '';
  let mandateB = '';
  let segment = '';
  let other = '';
  let template = '';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
    await api.call('profiles.import', {
      label: 'Compare test',
      rows: ['ada', 'bo'].map((name) => ({
        email: `${name}@example.com`,
        consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
      })),
    });
    for (const [name, set] of [
      ['Compare readers', (id: string) => (segment = id)],
      ['Another audience', (id: string) => (other = id)],
    ] as const) {
      const seg = await api.call('artifacts.create', { type: 'segment', name, content: { condition: { consent: 'marketing_email' } } });
      await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
      set(seg.artifactId);
    }
    await eventually(
      () => api.call('segments.refresh', { artifactId: segment }),
      (r) => r.members === 2,
    );
    const tpl = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Compare issue',
      content: { purpose: 'marketing_email', subject: 'This week', mjml },
    });
    await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
    template = tpl.artifactId;
    await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
    a = await makeAgent(api, 'Compare agent A', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    b = await makeAgent(api, 'Compare agent B', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    const scope = { segments: [segment], purposes: ['marketing_email'], topics: [], channels: ['email'], artifactTypes: [], artifacts: [] };
    mandateA = await grantMandate(api, a.agentId, 'Mandate A', { levels: { 'send.broadcast': 3 }, scope });
    mandateB = await grantMandate(api, b.agentId, 'Mandate B', { levels: { 'send.broadcast': 3 }, scope });
  }, 120_000);

  it('puts two agents with different outcomes side by side over a period', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    // A publishes a broadcast to the audience; B publishes one too and then tries another audience.
    const broadcastA = await draftBroadcast(a.token, 'A issue', template, segment);
    expect((await agentCall(a.token, 'artifacts.requestPublish', { artifactId: broadcastA, note: 'A issue' })).body.status).toBe(
      'published',
    );
    const broadcastB = await draftBroadcast(b.token, 'B issue', template, segment);
    expect((await agentCall(b.token, 'artifacts.requestPublish', { artifactId: broadcastB, note: 'B issue' })).body.status).toBe(
      'published',
    );
    const outside = await draftBroadcast(b.token, 'B outside', template, other);
    const held = await agentCall(b.token, 'artifacts.requestPublish', { artifactId: outside, note: 'outside my audience' });
    expect(held.body.status).toBe('in_review');
    expect(held.body.heldBecause.join(' ')).toContain(`Audience ${other} is outside this agent’s mandate`);

    // Only A's broadcast is opened: the outcomes differ even though both sent the same number.
    const messages = await eventually(
      () =>
        t.srv.db.admin.query<{ id: string; profile_id: string }>('SELECT id, profile_id FROM messages WHERE journey_id = $1 ORDER BY id', [
          broadcastA,
        ]),
      (r) => r.rows.length === 2,
      30_000,
    );
    await t.srv.events.insertMessageEvents(
      messages.rows.map((m) => ({
        workspaceId: ws,
        messageId: m.id,
        eventId: `open:${m.id}`,
        type: 'opened' as const,
        at: new Date().toISOString(),
        profileId: m.profile_id,
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: template,
        templateVersion: 1,
        journeyId: broadcastA,
        reason: '',
        url: '',
      })),
    );

    const comparison = await eventually(
      async () => {
        clearAnalyticsCache();
        return api.call('agents.compare', { from, to });
      },
      (r) => {
        const ca = r.agents.find((x) => x.agentId === a.agentId);
        const cb = r.agents.find((x) => x.agentId === b.agentId);
        return ca?.outcomes?.broadcasts?.opened === 2 && cb?.outcomes?.broadcasts?.sent === 2 && ca.outcomes.broadcasts.sent === 2;
      },
      30_000,
    );

    const ca = comparison.agents.find((x) => x.agentId === a.agentId)!;
    const cb = comparison.agents.find((x) => x.agentId === b.agentId)!;
    expect(ca.outcomes?.broadcasts).toMatchObject({ count: 1, sent: 2, opened: 2 });
    expect(cb.outcomes?.broadcasts).toMatchObject({ count: 1, sent: 2, opened: 0 });
    expect(ca.mandates).toEqual([expect.objectContaining({ mandateId: mandateA, version: 1, active: true })]);
    expect(cb.mandates).toEqual([expect.objectContaining({ mandateId: mandateB, version: 1, active: true })]);
    expect(ca.mandates[0]?.actions['send.broadcast']).toMatchObject({ allow: 1, ask: 0, deny: 0 });
    expect(cb.mandates[0]?.actions['send.broadcast']).toMatchObject({ allow: 1, ask: 1, deny: 0 });
    expect(ca.goalsTotal).toBe(0);
  }, 60_000);
});

describe('agents.renewals and agents.renewMandates (#428)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  const mandates: string[] = [];

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    for (let i = 0; i < 3; i++) {
      const agent = await makeAgent(api, `Renewal agent ${i + 1}`, ['artifacts:read']);
      mandates.push(await grantMandate(api, agent.agentId, `Renewal mandate ${i + 1}`, { validUntil: inDays(5 + i * 5) }));
    }
    // One of them already lapsed while its agent is still active: renewals must still list it.
    await t.srv.db.admin.query(
      `UPDATE artifact_versions SET content = jsonb_set(content, '{validUntil}', to_jsonb($2::text))
       WHERE workspace_id = $1 AND artifact_id = $3 AND number = 1`,
      [ws, new Date(Date.now() - 86_400_000).toISOString(), mandates[2]],
    );
  }, 90_000);

  it('lists the mandates that lapse soon and the expired ones still attached to active agents', async () => {
    const listed = await api.call('agents.renewals', { withinDays: 30 });
    expect(listed.renewals.map((r) => r.mandateId).sort()).toEqual([...mandates].sort());
    expect(listed.renewals.find((r) => r.mandateId === mandates[2])?.expired).toBe(true);
    expect(listed.renewals.find((r) => r.mandateId === mandates[0])?.expired).toBe(false);
  });

  it('renews three mandates in one call, with one audit entry per mandate and the new validUntil', async () => {
    const validUntil = inDays(60);
    const out = await api.call('agents.renewMandates', { mandateIds: mandates, validUntil, note: 'Quarterly review' });
    expect(out.renewed).toHaveLength(3);
    for (const r of out.renewed) {
      expect(r).toMatchObject({ ok: true, status: 'published', version: 2, validUntil: new Date(validUntil).toISOString() });
    }
    const { rows } = await t.srv.db.admin.query<{ target: string; ok: boolean }>(
      `SELECT target, ok FROM audit_log WHERE workspace_id = $1 AND command = 'agents.renewMandates' ORDER BY seq`,
      [ws],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.target).sort()).toEqual([...mandates].sort());
    expect(rows.every((r) => r.ok)).toBe(true);
    for (const id of mandates) {
      const got = await api.call('artifacts.get', { artifactId: id });
      expect(got.publishedVersion).toBe(2);
      expect((got.version.content as { validUntil: string }).validUntil).toBe(new Date(validUntil).toISOString());
    }
  });
});

describe('ad audiences and conversions under a mandate (#428)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let agent: Agent;
  let mandate = '';
  let segment = '';
  let connection = '';
  let mapId = '';
  let syncId = '';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    const seg = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Ads audience',
      content: { condition: { consent: 'marketing_email' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
    segment = seg.artifactId;
    connection = (
      await api.call('connections.create', {
        connector: 'meta_ads',
        name: 'Meta',
        settings: { pixelId: '123456789', apiBase: 'https://example.com' },
        secrets: { accessToken: 'meta-system-user-token-0123456789' },
      })
    ).id;
    await api.call('workspace.setAutonomy', { maxLevel: { 'audience.publish': 3 } });
    agent = await makeAgent(api, 'Ads agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    mandate = await grantMandate(api, agent.agentId, 'Ads mandate', {
      levels: { 'audience.publish': 3 },
      scope: {
        segments: [segment],
        purposes: ['ad_measurement'],
        topics: [],
        channels: ['email'],
        artifactTypes: [],
        artifacts: [],
      },
    });
  }, 90_000);

  const conversionMap = () => ({
    rules: [{ event: 'Order Completed', meta: { connection, eventName: 'Purchase' } }],
  });
  const audienceSync = () => ({ segment, meta: { connection, audienceId: '99887766' } });

  it('holds a conversion map and an audience sync when the mandate lacks the ads channel', async () => {
    const map = await agentCall(agent.token, 'artifacts.create', {
      type: 'conversion_map',
      name: 'Conversions',
      content: conversionMap(),
    });
    mapId = map.body.artifactId;
    const heldMap = await agentCall(agent.token, 'artifacts.requestPublish', { artifactId: mapId, note: 'conversions' });
    expect(heldMap.body).toMatchObject({ status: 'in_review' });
    expect(heldMap.body.heldBecause.join(' ')).toContain('Channel ads is outside this agent’s mandate');

    const sync = await agentCall(agent.token, 'artifacts.create', {
      type: 'audience_sync',
      name: 'Audience sync',
      content: audienceSync(),
    });
    syncId = sync.body.artifactId;
    const heldSync = await agentCall(agent.token, 'artifacts.requestPublish', { artifactId: syncId, note: 'audience' });
    expect(heldSync.body).toMatchObject({ status: 'in_review' });
    expect(heldSync.body.heldBecause.join(' ')).toContain('Channel ads is outside this agent’s mandate');

    // The ledger shows the ads channel in the impact, for both.
    const { actions } = await api.call('agents.activity', { agentId: agent.agentId, actionClass: 'audience.publish', limit: 10 });
    expect(actions.some((x) => (x.impact.touches as { channels?: string[] } | undefined)?.channels?.includes('ads'))).toBe(true);
  });

  it('allows them once the mandate grants the ads channel', async () => {
    const current = await api.call('artifacts.get', { artifactId: mandate });
    const content = current.version.content as { scope: Record<string, unknown> } & Record<string, unknown>;
    await api.call('artifacts.updateDraft', {
      artifactId: mandate,
      content: { ...content, scope: { ...content.scope, channels: ['email', 'ads'] } } as never,
      note: 'Add the ads channel',
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate, note: 'Add the ads channel' })).status).toBe('published');

    // The held versions are in review; a new draft (v2) is what the agent publishes now.
    await agentCall(agent.token, 'artifacts.updateDraft', { artifactId: mapId, content: conversionMap() });
    expect((await agentCall(agent.token, 'artifacts.requestPublish', { artifactId: mapId, note: 'conversions' })).body.status).toBe(
      'published',
    );

    await agentCall(agent.token, 'artifacts.updateDraft', { artifactId: syncId, content: audienceSync() });
    expect((await agentCall(agent.token, 'artifacts.requestPublish', { artifactId: syncId, note: 'audience' })).body.status).toBe(
      'published',
    );
  });
});
