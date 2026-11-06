import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import type { Permission } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

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

describe('concurrent mandate renewals (#455)', () => {
  it('serializes the hash check and draft write instead of overwriting a version', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agent = await makeAgent(api, 'Concurrent renewal agent', ['artifacts:read']);
    const mandate = await grantMandate(api, agent.agentId, 'Concurrent renewal mandate', { validUntil: inDays(10) });
    const untilA = inDays(60);
    const untilB = inDays(90);

    // Hold the artifact row so both renewals reach their read at the same time. With the row lock
    // they wait here; without it both read v1 and race to create v2.
    const client = await t.srv.db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, mandate]);
      const first = api.call('agents.renewMandates', { mandateIds: [mandate], validUntil: untilA, note: 'First' });
      const second = api.call('agents.renewMandates', { mandateIds: [mandate], validUntil: untilB, note: 'Second' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('COMMIT');
      const [a, b] = await Promise.all([first, second]);
      expect(a.renewed[0]).toMatchObject({ ok: true, error: null });
      expect(b.renewed[0]).toMatchObject({ ok: true, error: null });
    } finally {
      client.release();
    }

    const { rows } = await t.srv.db.admin.query<{ number: number; valid_until: string }>(
      `SELECT number, content->>'validUntil' AS valid_until FROM artifact_versions
        WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number`,
      [ws, mandate],
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(new Set(rows.filter((r) => r.number > 1).map((r) => r.valid_until))).toEqual(
      new Set([new Date(untilA).toISOString(), new Date(untilB).toISOString()]),
    );
    const [artifact] = await t.srv.db.admin
      .query<{ published_version: number; latest_version: number }>(
        `SELECT published_version, latest_version FROM artifacts WHERE workspace_id = $1 AND id = $2`,
        [ws, mandate],
      )
      .then((r) => r.rows);
    expect(artifact).toMatchObject({ published_version: 3, latest_version: 3 });
  });
});

describe('overlapping bulk renewals keep one lock order (#455, round 3)', () => {
  it('does not deadlock with an ordinary edit that holds one of the mandates', async () => {
    const w = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, w);
    const agentA = await makeAgent(api, 'Lock order agent A', ['artifacts:read']);
    const agentB = await makeAgent(api, 'Lock order agent B', ['artifacts:read']);
    const a = await grantMandate(api, agentA.agentId, 'First lock order mandate', { validUntil: inDays(10) });
    const b = await grantMandate(api, agentB.agentId, 'Second lock order mandate', { validUntil: inDays(20) });
    // The renewal locks and processes in id order, so `first` is the one it reaches before `second`.
    const [first, second] = [a, b].sort();

    const got = await api.call('artifacts.get', { artifactId: second });
    const edited = { ...(got.version.content as Record<string, unknown>), purpose: 'Edited while the renewals run' };

    const audit = await t.srv.db.admin.connect();
    const rowLock = await t.srv.db.admin.connect();
    try {
      // Hold the workspace audit lock (the renewal takes it while it publishes), and the second
      // mandate's row (the edit takes it before it asks for the audit lock).
      await audit.query('BEGIN');
      await audit.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit:${w}`]);
      await rowLock.query('BEGIN');
      await rowLock.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [w, second]);

      const edit = api.call('artifacts.updateDraft', { artifactId: second, content: edited, note: 'Edit during renewals' });
      const renewal = api.call('agents.renewMandates', {
        mandateIds: [first, second],
        validUntil: inDays(120),
        note: 'Overlapping bulk renewal',
      });
      // The edit waits for the second row, the renewal for the audit lock after it renews the first.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rowLock.query('COMMIT');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Pre-fix this releases the audit lock to the renewal, which then waits for the second row the
      // edit now holds: the two form a cycle. Locking the set in id order before any write avoids it.
      await audit.query('COMMIT');

      // Both finish (no deadlock). Which one reaches the second mandate first depends on scheduling;
      // either serial order is consistent, and each is checked for what it implies.
      const [draft, renewed] = await Promise.all([edit, renewal]);
      expect(renewed.renewed.find((r: { mandateId: string }) => r.mandateId === first)).toMatchObject({
        ok: true,
        version: 2,
      });
      const secondResult = renewed.renewed.find((r: { mandateId: string }) => r.mandateId === second);
      if (draft.version === 2) {
        // The edit ran first: the renewal refuses the mandate with a draft instead of overwriting it.
        expect(secondResult).toMatchObject({ ok: false });
      } else {
        // The renewal ran first: it published v2, and the edit's draft follows it as v3.
        expect(secondResult).toMatchObject({ ok: true, version: 2 });
        expect(draft.version).toBe(3);
      }
      const rows = await t.srv.db.admin.query<{ id: string; latest_version: number; published_version: number }>(
        'SELECT id, latest_version, published_version FROM artifacts WHERE workspace_id = $1 AND id IN ($2, $3) ORDER BY id',
        [w, a, b],
      );
      for (const row of rows.rows) {
        expect(row.latest_version).toBeGreaterThanOrEqual(row.published_version);
      }
      // Both decisions are in the audit chain, whichever order they ran in.
      const auditRows = await t.srv.db.admin.query('SELECT command FROM audit_log WHERE workspace_id = $1 ORDER BY seq', [w]);
      expect(auditRows.rows.filter((r: { command: string }) => r.command === 'agents.renewMandates')).toHaveLength(2);
      expect(auditRows.rows.filter((r: { command: string }) => r.command === 'artifacts.updateDraft')).toHaveLength(1);
    } finally {
      audit.release();
      rowLock.release();
    }
  }, 60_000);
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

describe('renewal safety and reporting (#455, #472, #482)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  const mandates: string[] = [];

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3 } });
    for (let i = 0; i < 3; i++) {
      const agent = await makeAgent(api, `Renewal safety agent ${i + 1}`, ['artifacts:read', 'artifacts:write']);
      mandates.push(await grantMandate(api, agent.agentId, `Renewal safety mandate ${i + 1}`, { validUntil: inDays(10 + i * 10) }));
    }
  }, 90_000);

  it('refuses a mandate with an unpublished draft instead of replacing and publishing it (#455)', async () => {
    const agent = await makeAgent(api, 'Draft renew agent', ['artifacts:read', 'artifacts:write']);
    const mandate = await grantMandate(api, agent.agentId, 'Draft renew mandate', {
      levels: { 'send.broadcast': 3 },
      validUntil: inDays(20),
    });
    const before = await api.call('artifacts.get', { artifactId: mandate });
    const content = before.version.content as Record<string, unknown> & { levels: Record<string, number> };
    // A pending safety change: reduce the level; renewal must not discard it.
    await api.call('artifacts.updateDraft', {
      artifactId: mandate,
      content: { ...content, levels: { ...content.levels, 'send.broadcast': 0 } } as never,
      note: 'Pending safety review',
    });

    const out = await api.call('agents.renewMandates', { mandateIds: [mandate], validUntil: inDays(200), note: 'Quarterly review' });
    expect(out.renewed[0]).toMatchObject({ ok: false, status: null, error: expect.stringMatching(/unpublished|discard/i) });

    const after = await api.call('artifacts.get', { artifactId: mandate });
    expect(after.publishedVersion).toBe(1);
    expect(after.latestVersion).toBe(2);
    expect((after.version.content as { levels: Record<string, number> }).levels['send.broadcast']).toBe(0);
  });

  it('rejects a validUntil in the past or more than a year away (#472)', async () => {
    const past = await rejects(api.call('agents.renewMandates', { mandateIds: [mandates[0]], validUntil: inDays(-1), note: 'typo' }));
    expect(past.code).toBe('invalid_input');
    expect(JSON.stringify(past.details)).toMatch(/future/i);
    const far = await rejects(api.call('agents.renewMandates', { mandateIds: [mandates[0]], validUntil: inDays(400), note: 'too long' }));
    expect(far.code).toBe('invalid_input');
    expect(JSON.stringify(far.details)).toMatch(/year|366/i);
    // Neither rejected call published anything.
    expect((await api.call('artifacts.get', { artifactId: mandates[0] })).publishedVersion).toBe(1);
  });

  it('reports a recently expired mandate as negative and sorts newest expiry first (#482)', async () => {
    await t.srv.db.admin.query(
      `UPDATE artifact_versions SET content = jsonb_set(content, '{validUntil}', to_jsonb($2::text))
       WHERE workspace_id = $1 AND artifact_id = $3 AND number = 1`,
      [ws, new Date(Date.now() - 3_600_000).toISOString(), mandates[1]],
    );
    const listed = await api.call('agents.renewals', { withinDays: 365 });
    const expired = listed.renewals.find((r) => r.mandateId === mandates[1]);
    expect(expired).toMatchObject({ expired: true });
    expect(expired!.daysLeft).toBeLessThan(0);
    // Newest expiry first, as the description promises.
    const expiries = listed.renewals.map((r) => r.validUntil);
    expect(expiries).toEqual([...expiries].sort().reverse());
  });
});

describe('comparison bounds and hold counting (#470, #489)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let agent: Agent;
  let mandate = '';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3 } });
    agent = await makeAgent(api, 'Hold count agent', ['artifacts:read', 'artifacts:write']);
    mandate = await grantMandate(api, agent.agentId, 'Hold count mandate', { levels: { 'send.broadcast': 2 } });
  }, 90_000);

  it('counts one hold once when its recheck row is in the window (#470)', async () => {
    const approvalId = 'apr_00000000000000000000000000000070';
    const impact = JSON.stringify({ approvalId });
    await t.srv.db.admin.query(
      `INSERT INTO approval_requests (workspace_id, id, artifact_id, version, status, requested_by_type, requested_by_id, note)
       VALUES ($1, $2, $3, 1, 'pending', 'agent', $4, 'held')`,
      [ws, approvalId, mandate, agent.agentId],
    );
    for (const command of ['artifacts.requestPublish', 'artifacts.heldRecheck'])
      await t.srv.db.admin.query(
        `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, impact, ok, target, surface, mandate_id, mandate_version, at)
         VALUES ($1, $2, $3, 'send.broadcast', 'hold', $4::jsonb, true, $5, 'internal', $6, 1, now())`,
        [ws, agent.agentId, command, impact, mandate, mandate],
      );

    const now = new Date();
    const compared = await api.call('agents.compare', {
      agentIds: [agent.agentId],
      from: new Date(now.getTime() - 3_600_000).toISOString(),
      to: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const bucket = compared.agents[0]!.mandates.find((m) => m.mandateId === mandate);
    expect(bucket?.actions['send.broadcast']).toMatchObject({ hold: 1 });
    expect(bucket?.holds).toEqual({ rejected: 0, ran: 0, pending: 1 });
  });

  it('caps an unbounded compare to the 20 most recently active agents (#489)', async () => {
    const compareWs = await t.workspaceWith([[owner, 'owner']], 'none');
    const compareApi = t.api(owner, compareWs);
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const id = `agt_${String(i).padStart(32, '0')}`;
      ids.push(id);
      // Index 0 is the oldest; index 20 the newest.
      await t.srv.db.admin.query(
        `INSERT INTO agents (workspace_id, id, name, sponsor_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval, now())`,
        [compareWs, id, `Agent ${i}`, owner.id, String(21 - i)],
      );
    }
    // The oldest agent acted just now, so it is the most recently active and must be included; the
    // next oldest (inactive) is the one the cap leaves out.
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface, at)
       VALUES ($1, $2, 'artifacts.get', 'read', 'allow', true, 'api', now())`,
      [compareWs, ids[0]],
    );
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const out = await compareApi.call('agents.compare', { from, to });
    expect(out.truncated).toBe(true);
    expect(out.agents).toHaveLength(20);
    expect(out.agents.map((a) => a.agentId)).toContain(ids[0]);
    expect(out.agents.map((a) => a.agentId)).not.toContain(ids[1]);

    // Explicit ids are not silently truncated (they are already bounded by the input schema).
    const explicit = await compareApi.call('agents.compare', { agentIds: [ids[1]], from, to });
    expect(explicit.truncated).toBe(false);
    expect(explicit.agents.map((a) => a.agentId)).toEqual([ids[1]]);
  });

  it('bounds the agent count and the comparison window (#489)', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `agt_${String(i).padStart(32, '0')}`);
    const tooMany = await rejects(api.call('agents.compare', { agentIds: many }));
    expect(tooMany.message).toMatch(/at most 20/i);
    const tooLong = await rejects(
      api.call('agents.compare', {
        from: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      }),
    );
    expect(tooLong.message).toContain('366');
  });
});

describe('comparison active flags across versions (#458)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let agent: Agent;
  let mandate = '';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    agent = await makeAgent(api, 'Compare versions agent', ['artifacts:read', 'artifacts:write']);
    mandate = await grantMandate(api, agent.agentId, 'Compare versions mandate', { validUntil: inDays(30) });
  }, 90_000);

  it('marks only the published version still in force as active (#458)', async () => {
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 60_000);
    const draft = (name: string) =>
      agentCall(agent.token, 'artifacts.create', { type: 'note', name, content: { title: name, body: 'Action' } });

    expect((await draft('Under v1')).status).toBe(200);
    expect((await api.call('agents.renewMandates', { mandateIds: [mandate], validUntil: inDays(60), note: 'Renew' })).renewed[0]?.ok).toBe(
      true,
    );
    expect((await draft('Under v2')).status).toBe(200);

    const compared = await api.call('agents.compare', { agentIds: [agent.agentId], from: from.toISOString(), to: to.toISOString() });
    const versions = compared.agents[0]!.mandates;
    expect(versions.find((v) => v.version === 1)).toMatchObject({ active: false, validUntil: expect.any(String) });
    expect(versions.find((v) => v.version === 2)).toMatchObject({ active: true });

    // Archiving the artifact takes its published version out of force too.
    await t.srv.db.admin.query(`UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2`, [ws, mandate]);
    const archived = await api.call('agents.compare', { agentIds: [agent.agentId], from: from.toISOString(), to: to.toISOString() });
    expect(archived.agents[0]!.mandates.find((v) => v.version === 2)?.active).toBe(false);
  });
});
