import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 18 (ADR-0016 §4.5, #231): before an autonomous (or held) action a second model
// compares the agent's intent with the action and the mandate. A match lets the action run; a
// mismatch, a missing provider or an unreadable answer drops it to a person (fail closed).

let t: Awaited<ReturnType<typeof startTestServer>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let owner: User;
let token = '';
let agentId = '';
let segmentId = '';
let templateId = '';
let providerId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const newsletterScope = { segments: [] as string[], purposes: ['marketing_email'], channels: ['email'] };

function answer(r: FakeRequest) {
  if (!r.system.includes('independent reviewer')) return { status: 500, error: 'unexpected request' };
  // The agent's own note says it is giving away tents: outside the mandate's purpose.
  if (r.user.includes('free tents'))
    return { text: JSON.stringify({ match: false, reason: 'The action promises a giveaway that is outside the mandate’s purpose.' }) };
  return { text: JSON.stringify({ match: true, reason: 'The action matches the intent and stays inside the mandate’s scope.' }) };
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_independent_check', testPort(3480));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
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
    label: 'Independent check test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'News',
    content: { condition: { consent: 'marketing_email' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
  segmentId = seg.artifactId;
  await eventually(
    () => api.call('segments.refresh', { artifactId: seg.artifactId }),
    (r) => r.members === 3,
  );
  token = (
    await api.call('apiTokens.create', {
      name: 'Newsletter agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
  providerId = (
    await api.call('aiProviders.create', {
      name: 'Model',
      kind: 'anthropic-compatible',
      baseUrl: llm.baseUrl,
      models: { default: 'claude-sonnet-test' },
      apiKey: 'sk-test-0123456789',
      useFor: ['journeys'],
    })
  ).id;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Newsletter mandate',
    content: {
      agent: agentId,
      purpose: 'Send the weekly newsletter',
      validUntil: inDays(30),
      scope: { ...newsletterScope, segments: [segmentId] },
      levels: { 'send.broadcast': 3, 'content.publish': 3 },
      independentCheck: true,
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}, 90_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const draftBroadcast = async () =>
  (
    await call('artifacts.create', {
      type: 'broadcast',
      name: `Issue ${Date.now()}`,
      content: { template: templateId, segment: segmentId },
    })
  ).body.artifactId as string;

describe('the independent model check (#231)', () => {
  it('lets a matching action run autonomously, logs it and records the verdict in the ledger', async () => {
    const id = await draftBroadcast();
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Send this week’s issue to the newsletter readers' });
    expect(out.body.status).toBe('published');

    const { actions } = await t.api(owner).call('agents.activity', { agentId, limit: 5 });
    expect(actions[0]).toMatchObject({ decision: 'allow', actionClass: 'send.broadcast' });
    expect(actions[0].reasons.join(' ')).toContain('Independent check');
    expect(actions[0].reasons.join(' ')).toContain('matches the intent');

    // The check is an AI call of its own, with a compact prompt and no secrets.
    const { calls } = await t.api(owner).call('ai.calls', { kind: 'check' });
    expect(calls[0]).toMatchObject({ kind: 'check', status: 'done', output: { match: true } });
    expect(calls[0].rationale).toContain('matches the intent');
    const req = llm.requests.at(-1)!;
    expect(req.system).toContain('untrusted');
    expect(req.user).toContain('<mandate>');
    expect(req.user).toContain('Send the weekly newsletter');
  });

  it('sends a mismatch to a person with the model’s reason', async () => {
    const id = await draftBroadcast();
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Give away free tents to everyone' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Independent check');
    expect(out.body.heldBecause.join(' ')).toContain('giveaway that is outside the mandate’s purpose');
  });

  it('gives the model the content and the diff of a level-3 publish (#261)', async () => {
    const before = llm.requests.length;
    await call('artifacts.updateDraft', {
      artifactId: templateId,
      content: {
        purpose: 'marketing_email',
        subject: 'Signal 43: this week',
        mjml: mjml.replace('Hej', 'Hej from the newsroom'),
      },
    });
    const out = await call('artifacts.requestPublish', {
      artifactId: templateId,
      note: 'Refresh the weekly issue with this week’s story',
    });
    expect(out.body.status).toBe('published');

    const req = llm.requests.slice(before).find((r) => r.system.includes('independent reviewer') && r.user.includes('<published-content>'));
    expect(req).toBeDefined();
    // The content being published, not just the id and the note.
    expect(req!.user).toContain('Hej from the newsroom');
    expect(req!.user).toContain('Signal 43: this week');
    // And the structural diff against the version that is live now.
    expect(req!.user).toContain('"kind":"changed"');
    expect(req!.user).toContain('"path":"mjml"');
  });

  it('sends the change to a person when the note matches but the content does not (#261)', async () => {
    // A person writes the draft; only the agent's publish is under review here.
    await t.api(owner).call('artifacts.updateDraft', {
      artifactId: templateId,
      content: {
        purpose: 'marketing_email',
        subject: 'A gift for you',
        mjml: mjml.replace('Hej', 'free tents for everyone who joins this week'),
      },
    });
    // The note says exactly what the mandate allows; only the content is outside it.
    const out = await call('artifacts.requestPublish', {
      artifactId: templateId,
      note: 'Send this week’s issue to the newsletter readers',
    });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Independent check');
    expect(out.body.heldBecause.join(' ')).toContain('giveaway that is outside the mandate’s purpose');

    const req = llm.requests.at(-1)!;
    expect(req.user).toContain('free tents for everyone who joins this week');
    expect(req.user).toContain('<published-content>');
  });

  // #642: a successful generateText means the provider billed tokens. The old finally released the
  // hold even when the usage row could not be written, so those tokens were counted nowhere.
  it('keeps the billed check covered when its usage row cannot be written', async () => {
    await t.srv.db.admin.query(`CREATE OR REPLACE FUNCTION check_ai_call_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'check' THEN RAISE EXCEPTION 'injected ai_calls failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await t.srv.db.admin.query('DROP TRIGGER IF EXISTS check_ai_call_fail_trg ON ai_calls');
    await t.srv.db.admin.query(
      'CREATE TRIGGER check_ai_call_fail_trg BEFORE INSERT ON ai_calls FOR EACH ROW EXECUTE FUNCTION check_ai_call_fail_fn()',
    );
    try {
      const api = t.api(owner);
      const before = (await api.call('aiProviders.list', {})).providers[0]!.usedThisMonth;
      const checksBefore = (await api.call('ai.calls', { kind: 'check' })).calls.length;
      const id = await draftBroadcast();
      const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Send this week’s issue' });
      // The check could not record its usage, so the action fails closed to a person.
      expect(out.body.status).toBe('in_review');
      expect((await api.call('ai.calls', { kind: 'check' })).calls.length).toBe(checksBefore);

      // The hold is the only record of the billed tokens, and the month still counts it.
      const held = await t.srv.db.admin.query<{ tokens: number; expires_at: Date }>(
        'SELECT tokens, expires_at FROM ai_token_reservations WHERE provider_id = $1',
        [providerId],
      );
      expect(held.rows).toHaveLength(1);
      const providers = await api.call('aiProviders.list', {});
      expect(providers.providers[0]!.usedThisMonth).toBe(before + held.rows[0]!.tokens);
      // Not the five-minute default: it survives the billing month.
      const now = new Date();
      expect(held.rows[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime(),
      );
    } finally {
      await t.srv.db.admin.query('DROP TRIGGER IF EXISTS check_ai_call_fail_trg ON ai_calls');
      await t.srv.db.admin.query('DROP FUNCTION IF EXISTS check_ai_call_fail_fn()');
      await t.srv.db.admin.query('DELETE FROM ai_token_reservations WHERE provider_id = $1', [providerId]);
    }
  }, 60_000);

  it('fails closed when no AI provider is set up', async () => {
    // Draft while the provider still exists; then remove it and publish, as an operator might.
    const id = await draftBroadcast();
    await t.api(owner).call('aiProviders.delete', { id: providerId });
    const out = await call('artifacts.requestPublish', { artifactId: id, note: 'Send this week’s issue' });
    expect(out.body.status).toBe('in_review');
    expect(out.body.heldBecause.join(' ')).toContain('Independent check');
    expect(out.body.heldBecause.join(' ')).toContain('no AI provider');
  });
});

describe('an idempotent replay of an agent write (#930)', () => {
  // The executor used to run `impact`, the policy engine (counters and the billed independent
  // check) before the idempotency lookup, so a retry of a succeeded write could be refused and
  // billed again. A non-approvable agent command makes the refusal visible: at its daily cap the
  // policy drops it to level 1, which for a command that cannot wait for a person is a denial.
  let replayToken = '';
  let replayAgent = '';
  let provider = '';
  let otherSegment = '';

  const checks = () => llm.requests.filter((r) => r.system.includes('independent reviewer')).length;
  const callAs = async (name: string, body: unknown, key: string) => {
    const res = await fetch(`${t.base}/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${replayToken}`, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const refresh = (artifactId: string, key: string) => callAs('segments.refresh', { artifactId }, key);
  const changes = async () =>
    (
      await t.srv.db.admin.query<{ changes: number }>(
        `SELECT count(*)::int AS changes FROM agent_actions
         WHERE agent_id = $1 AND decision = 'allow' AND ok AND action_class <> 'draft' AND at > now() - interval '24 hours'`,
        [replayAgent],
      )
    ).rows[0]!.changes;

  beforeAll(async () => {
    const api = t.api(owner);
    provider = (
      await api.call('aiProviders.create', {
        name: 'Model again',
        kind: 'anthropic-compatible',
        baseUrl: llm.baseUrl,
        models: { default: 'claude-sonnet-test' },
        apiKey: 'sk-test-0123456789',
        useFor: ['journeys'],
      })
    ).id;
    replayToken = (
      await api.call('apiTokens.create', { name: 'Replay agent', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
    ).token;
    replayAgent = (await callAs('agents.get', {}, 'unused')).body.id;
    await api.call('workspace.setAutonomy', { maxLevel: { 'audience.publish': 3 } });
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Replay mandate',
      content: {
        agent: replayAgent,
        purpose: 'Recompute the newsletter segment when a person asks',
        validUntil: inDays(30),
        scope: { segments: [segmentId], purposes: ['marketing_email'], channels: ['email'] },
        levels: { 'audience.publish': 3 },
        independentCheck: true,
      } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
    const second = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Another segment',
      content: { condition: { consent: 'marketing_email' } },
    });
    otherSegment = second.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: otherSegment, note: 'setup' });
  }, 60_000);

  it('replays without re-running the policy engine or the check when the agent is at its cap', async () => {
    const api = t.api(owner);
    const before = await changes();
    // The first refresh here exactly fills the cap; the retry then runs at the limit.
    await api.call('workspace.setAutonomy', { limits: { changesPerDay: before + 1 } });
    try {
      const first = await refresh(segmentId, 'replay-at-cap');
      expect(first.status).toBe(200);
      expect(first.body.members).toBe(3);
      const checkCount = checks();

      const again = await refresh(segmentId, 'replay-at-cap');
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect(checks()).toBe(checkCount);
    } finally {
      await api.call('workspace.setAutonomy', { limits: { changesPerDay: 500 } });
    }
  });

  it('replays the stored success when the independent check would now fail', async () => {
    const api = t.api(owner);
    const first = await refresh(segmentId, 'replay-check-fails');
    expect(first.status).toBe(200);
    const checkCount = checks();

    // Without a provider the check fails closed, which for a command that cannot wait for a person
    // is a denial. A replay must not re-ask it.
    await api.call('aiProviders.delete', { id: provider });
    try {
      const again = await refresh(segmentId, 'replay-check-fails');
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect(checks()).toBe(checkCount);
    } finally {
      provider = (
        await api.call('aiProviders.create', {
          name: 'Model restored',
          kind: 'anthropic-compatible',
          baseUrl: llm.baseUrl,
          models: { default: 'claude-sonnet-test' },
          apiKey: 'sk-test-0123456789',
          useFor: ['journeys'],
        })
      ).id;
    }
  });

  it('refuses a replay from a paused agent, as it refuses any of its writes', async () => {
    const api = t.api(owner);
    const first = await refresh(segmentId, 'replay-paused');
    expect(first.status).toBe(200);

    await api.call('agents.pause', { id: replayAgent });
    try {
      const again = await refresh(segmentId, 'replay-paused');
      expect(again.status).toBe(403);
      expect(again.body.message).toContain('paused');
    } finally {
      await api.call('agents.resume', { id: replayAgent });
    }
  });

  it('answers a different request with the same key as a conflict without running policy or the check', async () => {
    const first = await refresh(segmentId, 'replay-reused');
    expect(first.status).toBe(200);
    const checkCount = checks();

    const reused = await refresh(otherSegment, 'replay-reused');
    expect(reused.status).toBe(409);
    expect(reused.body.details?.reason).toBe('idempotency_key_reused');
    expect(checks()).toBe(checkCount);
  });

  it('runs a concurrent same-key agent write once, with one check', async () => {
    const before = checks();
    const activity = async () =>
      (await t.api(owner).call('agents.activity', { agentId: replayAgent, limit: 100 })).actions.filter(
        (x) => x.command === 'segments.refresh',
      ).length;
    const actionsBefore = await activity();
    const [a, b] = await Promise.all([refresh(segmentId, 'replay-concurrent'), refresh(segmentId, 'replay-concurrent')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(checks()).toBe(before + 1);
    expect(await activity()).toBe(actionsBefore + 1);
  }, 60_000);
});
