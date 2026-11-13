import { agentPolicy, agentPrincipal, type Permission } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Several agents in one workspace (#426): artifact ownership, conflict holds and cross-agent
// contact pressure. People are never affected by the three caps.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

interface Agent {
  token: string;
  agentId: string;
}

beforeAll(async () => {
  t = await startTestServer('test_agent_coordination', testPort(4260));
  owner = await t.signUp(`owner-coordination-${Date.now()}@example.com`);
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

const note = (title: string) => ({ title, body: 'Written for the coordination test.' });
const journey = (label = 'Done') => ({
  purpose: 'marketing_email',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up', reentry: 'once' }, next: [{ to: 'exit' }] },
    { id: 'exit', kind: 'exit', label, config: {} },
  ],
});

describe('artifact ownership (#426)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let a: Agent;
  let b: Agent;
  const journeyAgent = { token: '', agentId: '' } as Agent;
  let resource = '';
  let transfer = '';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    a = await makeAgent(api, 'Newsletter agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    b = await makeAgent(api, 'Journey agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    const ownerAgent = await makeAgent(api, 'Journey owner', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    journeyAgent.token = ownerAgent.token;
    journeyAgent.agentId = ownerAgent.agentId;
    const created = await agentCall(a.token, 'artifacts.create', { type: 'note', name: 'Owned note', content: note('Owned') });
    resource = created.body.artifactId;
    const other = await agentCall(a.token, 'artifacts.create', { type: 'note', name: 'Transferable note', content: note('Transfer') });
    transfer = other.body.artifactId;
  }, 90_000);

  it('an agent owns the artifact it creates, and reads it back', async () => {
    const got = await api.call('artifacts.get', { artifactId: resource });
    expect(got.ownerAgentId).toBe(a.agentId);
    const listed = await api.call('artifacts.list', { type: 'note' });
    expect(listed.artifacts.find((x) => x.id === resource)?.ownerAgentId).toBe(a.agentId);
  });

  it('the owner publishes its own artifact', async () => {
    const out = await agentCall(a.token, 'artifacts.requestPublish', { artifactId: resource, note: 'Our own note' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'published', version: 1 });
  });

  it('another agent’s publish of an owned artifact waits for a person, with the reason', async () => {
    const edited = await agentCall(b.token, 'artifacts.updateDraft', {
      artifactId: resource,
      content: note('Edited by the other agent'),
    });
    expect(edited.status).toBe(200);
    const out = await agentCall(b.token, 'artifacts.requestPublish', { artifactId: resource, note: 'Let me change this' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'in_review' });
    expect(out.body.heldBecause).toEqual(expect.arrayContaining([expect.stringContaining('is owned by agent Newsletter agent')]));
    const activity = await api.call('agents.activity', { agentId: b.agentId, actionClass: 'content.publish', limit: 1 });
    expect(activity.actions[0].reasons.join(' ')).toContain('is owned by agent Newsletter agent');
  });

  it('agent B publishing agent A’s journey is held; A itself is not', async () => {
    const created = await agentCall(journeyAgent.token, 'artifacts.create', {
      type: 'journey',
      name: 'Agent-owned journey',
      content: journey(),
    });
    const id = created.body.artifactId as string;
    expect((await agentCall(journeyAgent.token, 'artifacts.requestPublish', { artifactId: id, note: 'First version' })).body).toMatchObject(
      {
        status: 'published',
      },
    );

    // The owner changes it again: its own ownership never blocks it.
    await agentCall(journeyAgent.token, 'artifacts.updateDraft', { artifactId: id, content: journey('Finished') });
    expect((await agentCall(journeyAgent.token, 'artifacts.requestPublish', { artifactId: id, note: 'Our own edit' })).body).toMatchObject({
      status: 'published',
    });

    await agentCall(b.token, 'artifacts.updateDraft', { artifactId: id, content: journey('Changed by B') });
    const held = await agentCall(b.token, 'artifacts.requestPublish', { artifactId: id, note: 'Someone else’s journey' });
    expect(held.body).toMatchObject({ status: 'in_review' });
    expect(held.body.heldBecause?.join(' ')).toContain('is owned by agent Journey owner');
  });

  it('a paused owner does not block, but the ledger reports it', async () => {
    await api.call('agents.pause', { id: a.agentId, reason: 'On holiday' });
    const edited = await agentCall(b.token, 'artifacts.updateDraft', {
      artifactId: resource,
      content: note('Edited while the owner is paused'),
    });
    expect(edited.status).toBe(200);
    const out = await agentCall(b.token, 'artifacts.requestPublish', { artifactId: resource, note: 'While the owner is away' });
    expect(out.body).toMatchObject({ status: 'published' });
    const activity = await api.call('agents.activity', { agentId: b.agentId, actionClass: 'content.publish', limit: 1 });
    expect(activity.actions[0].reasons.join(' ')).toContain('which is not active');
  });

  it('artifacts.setOwner is people-only and audited', async () => {
    const refused = await agentCall(a.token, 'artifacts.setOwner', { artifactId: transfer, ownerAgentId: b.agentId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('can only be run by a person');

    const assigned = await api.call('artifacts.setOwner', { artifactId: transfer, ownerAgentId: b.agentId });
    expect(assigned).toEqual({ artifactId: transfer, ownerAgentId: b.agentId });
    expect((await api.call('artifacts.get', { artifactId: transfer })).ownerAgentId).toBe(b.agentId);

    const audit = await api.call('audit.list', { target: transfer, limit: 20 });
    expect(audit.entries.find((e) => e.command === 'artifacts.setOwner')).toMatchObject({
      principalType: 'user',
      principalId: owner.id,
      effect: 'write',
      ok: true,
    });

    const cleared = await api.call('artifacts.setOwner', { artifactId: transfer, ownerAgentId: null });
    expect(cleared.ownerAgentId).toBeNull();
    expect((await api.call('artifacts.get', { artifactId: transfer })).ownerAgentId).toBeNull();
  });
});

describe('conflict holds (#426)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let a: Agent;
  let b: Agent;
  let shared = '';

  beforeAll(async () => {
    // agent_changes: the first agent's publish waits for a person, so its request stays pending.
    ws = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
    api = t.api(owner, ws);
    a = await makeAgent(api, 'First agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    b = await makeAgent(api, 'Second agent', ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
    // A person creates it, so neither agent owns it and only the conflict can hold the second.
    const created = await api.call('artifacts.create', { type: 'note', name: 'Shared note', content: note('Shared') });
    shared = created.artifactId;
  }, 90_000);

  it('the second agent’s change is held while the first has one pending', async () => {
    expect((await agentCall(a.token, 'artifacts.updateDraft', { artifactId: shared, content: note('First edit') })).status).toBe(200);
    const first = await agentCall(a.token, 'artifacts.requestPublish', { artifactId: shared, note: 'First change' });
    expect(first.body).toMatchObject({ status: 'in_review' });

    expect((await agentCall(b.token, 'artifacts.updateDraft', { artifactId: shared, content: note('Second edit') })).status).toBe(200);
    const second = await agentCall(b.token, 'artifacts.requestPublish', { artifactId: shared, note: 'Second change' });
    expect(second.body).toMatchObject({ status: 'in_review' });
    expect(second.body.heldBecause).toEqual(expect.arrayContaining([expect.stringMatching(/already has .* from agent First agent/)]));

    // The owner's report shows the pending change from the other agent.
    await api.call('artifacts.setOwner', { artifactId: shared, ownerAgentId: a.agentId });
    const report = await api.call('agents.report', { agentId: a.agentId });
    expect(report.ownedArtifacts).toContain(shared);
    expect(report.heldConflicts ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ artifactId: shared, agentName: 'Second agent', kind: 'approval' })]),
    );
    expect((report.heldConflicts ?? [])[0]?.agentId).toBe(b.agentId);
  });
});

describe('cross-agent contact pressure (#426)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let a: Agent;
  let b: Agent;
  let profileId = '';
  let templateId = '';
  let segmentId = '';

  const mjml =
    '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
    const template = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Coordination issue',
      content: { purpose: 'marketing_email', subject: 'This week', mjml },
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'setup' })).status).toBe('published');
    templateId = template.artifactId;
    await api.call('profiles.import', {
      label: 'Coordination test',
      rows: [{ email: 'ada@example.com', userId: 'ada', consent: [{ purpose: 'marketing_email', status: 'granted' }] }],
    });
    profileId = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: 'ada' }),
        (r) => !!r.profileId,
      )
    ).profileId as string;
    const segment = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Coordination readers',
      content: { condition: { consent: 'marketing_email' } },
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'setup' })).status).toBe('published');
    segmentId = segment.artifactId;
    await eventually(
      () => api.call('segments.refresh', { artifactId: segmentId }),
      (r) => r.members === 1,
    );
    a = await makeAgent(api, 'First sender', ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send']);
    b = await makeAgent(api, 'Second sender', ['artifacts:read', 'messages:send']);
    await api.call('workspace.setAutonomy', { contactPressure: [{ max: 1, days: 7 }] });
  }, 120_000);

  const messages = () => api.call('messages.list', { profileId, limit: 20 });

  it('caps the second agent message across agents, and ignores human-originated sends', async () => {
    // A person's marketing message does not consume the agent cap.
    const human = await api.call('messages.sendEmail', { profileId, templateId, idempotencyKey: 'human' });
    await eventually(
      () => messages(),
      (r) => r.messages.find((m) => m.id === human.messageId)?.status === 'sent',
    );

    const first = await agentCall(a.token, 'messages.sendEmail', { profileId, templateId, idempotencyKey: 'agent-a' });
    expect(first.status).toBe(200);
    await eventually(
      () => messages(),
      (r) => r.messages.find((m) => m.id === first.body.messageId)?.status === 'sent',
    );

    const second = await agentCall(b.token, 'messages.sendEmail', { profileId, templateId, idempotencyKey: 'agent-b' });
    expect(second.status).toBe(200);
    const capped = await eventually(
      () => messages(),
      (r) => r.messages.find((m) => m.id === second.body.messageId)?.status === 'suppressed',
    );
    expect(capped.messages.find((m) => m.id === second.body.messageId)?.reason).toMatch(/^agent_contact_pressure:/);

    const { rows } = await t.srv.db.admin.query<{ id: string; agent_id: string | null; status: string }>(
      `SELECT id, agent_id, status FROM messages WHERE workspace_id = $1 ORDER BY created_at`,
      [ws],
    );
    expect(rows.find((m) => m.id === human.messageId)?.agent_id).toBeNull();
    expect(rows.find((m) => m.id === first.body.messageId)?.agent_id).toBe(a.agentId);
    expect(rows.find((m) => m.id === second.body.messageId)?.agent_id).toBe(b.agentId);

    // The report counts the messages the cap skipped for the agent that tried to send it.
    expect((await api.call('agents.activity', { agentId: b.agentId })).contactPressureSkipped).toBe(1);
    expect((await api.call('agents.report', { agentId: b.agentId })).contactPressureSkipped).toBe(1);
    expect((await api.call('agents.report', { agentId: a.agentId })).contactPressureSkipped).toBe(0);
  });

  it('records the owning agent on a broadcast message', async () => {
    // The cap is off for this check; only the message's agent id matters.
    await api.call('workspace.setAutonomy', { contactPressure: [] });
    const broadcast = await agentCall(a.token, 'artifacts.create', {
      type: 'broadcast',
      name: 'Agent-owned broadcast',
      content: { template: templateId, segment: segmentId },
    });
    expect(broadcast.status).toBe(200);
    const published = await agentCall(a.token, 'artifacts.requestPublish', {
      artifactId: broadcast.body.artifactId,
      note: 'Send the agent-owned issue',
    });
    expect(published.body).toMatchObject({ status: 'published' });
    await eventually(
      () => api.call('broadcasts.status', { artifactId: broadcast.body.artifactId }),
      (r) => r.run.status === 'done',
      30_000,
    );
    const { rows } = await t.srv.db.admin.query<{ agent_id: string | null }>(
      `SELECT agent_id FROM messages WHERE workspace_id = $1 AND journey_id = $2`,
      [ws, broadcast.body.artifactId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBe(a.agentId);
  });
});

describe('migration (#426)', () => {
  it('adds the two nullable columns and the contact-pressure index', async () => {
    const columns = await t.srv.db.admin.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE (table_name = 'artifacts' AND column_name = 'owner_agent_id')
          OR (table_name = 'messages' AND column_name = 'agent_id')`,
    );
    expect(columns.rows).toHaveLength(2);
    expect(columns.rows.every((r) => r.is_nullable === 'YES')).toBe(true);
    const index = await t.srv.db.admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' AND indexname = 'messages_agent_contact'`,
    );
    expect(index.rows).toHaveLength(1);
  });
});

describe('cancelling a send is a coordinated change (#468)', () => {
  let api: ReturnType<typeof t.api>;
  let ws = '';
  let a: Agent;
  let b: Agent;
  const template = `eml_${'1'.repeat(32)}`;
  const segment = `seg_${'2'.repeat(32)}`;

  beforeAll(async () => {
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
    api = t.api(owner, ws);
    a = await makeAgent(api, 'Cancelling agent A', ['artifacts:read', 'artifacts:write', 'messages:send']);
    b = await makeAgent(api, 'Cancelling agent B', ['artifacts:read', 'artifacts:write', 'messages:send']);
    await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
    for (const [agent, name] of [
      [a, 'Cancel mandate A'],
      [b, 'Cancel mandate B'],
    ] as const) {
      const mandate = await api.call('artifacts.create', {
        type: 'agent_mandate',
        name,
        content: {
          agent: agent.agentId,
          purpose: 'Send the weekly newsletter',
          validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          levels: { 'send.broadcast': 3, 'content.publish': 3 },
        } as never,
      });
      expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
    }
  }, 90_000);

  it('another agent cannot cancel an agent-owned send without a person (#468)', async () => {
    const created = await agentCall(a.token, 'artifacts.create', {
      type: 'broadcast',
      name: 'Agent A send',
      content: { template, segment },
    });
    const broadcast = created.body.artifactId as string;

    const refused = await agentCall(b.token, 'broadcasts.cancel', { artifactId: broadcast });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('owned by agent');

    // The owner may still stop its own send.
    const own = await agentCall(a.token, 'broadcasts.cancel', { artifactId: broadcast });
    expect(own.status, own.body.message).toBe(200);
    expect(own.body.status).toBe('cancelled');
  });

  it('another agent cannot discard a draft on an artifact it does not own (#468)', async () => {
    const created = await agentCall(a.token, 'artifacts.create', {
      type: 'note',
      name: 'Agent A note',
      content: { title: 'Owned', body: 'First' },
    });
    const noteId = created.body.artifactId as string;
    expect((await api.call('artifacts.requestPublish', { artifactId: noteId, note: 'publish' })).status).toBe('published');
    expect(
      (
        await agentCall(a.token, 'artifacts.updateDraft', {
          artifactId: noteId,
          content: { title: 'Owned', body: 'Changed' },
          note: 'draft',
        })
      ).status,
    ).toBe(200);

    const refused = await agentCall(b.token, 'artifacts.discardDraft', { artifactId: noteId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('owned by agent');
    expect((await api.call('artifacts.get', { artifactId: noteId })).latestVersion).toBe(2);
  });
});

describe('coordination decides under the artifact lock (#471)', () => {
  it('waits for a competing artifact write before reading the owner', async () => {
    const lockWs = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, lockWs);
    const agent = await makeAgent(api, 'Locked action agent', ['artifacts:read', 'artifacts:write']);
    const newOwner = await makeAgent(api, 'Late owner', ['artifacts:read']);
    const created = await agentCall(agent.token, 'artifacts.create', {
      type: 'note',
      name: 'Locked note',
      content: { title: 'Locked', body: 'Coordination lock test' },
    });
    const artifactId = created.body.artifactId as string;
    const principal = agentPrincipal(owner.id, 'token:locked-action', lockWs, 'owner', ['artifacts:read', 'artifacts:write'], {
      id: agent.agentId,
      name: 'Locked action agent',
      status: 'active',
      statusReason: null,
    });

    const lock = await t.srv.db.admin.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [lockWs, artifactId]);
      // The transfer is in flight; a coordination read must not decide on the old owner.
      await lock.query('UPDATE artifacts SET owner_agent_id = $3 WHERE workspace_id = $1 AND id = $2', [
        lockWs,
        artifactId,
        newOwner.agentId,
      ]);
      let settled = false;
      const decision = t.srv.db
        .withWorkspace(lockWs, (tx) =>
          agentPolicy(tx, t.srv.services, principal, {
            command: 'artifacts.requestPublish',
            actionClass: 'content.publish',
            impact: { touches: { artifacts: [{ id: artifactId, type: 'note' }] } },
            approvable: true,
            input: {},
          }),
        )
        .then((policy) => {
          settled = true;
          return policy;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await lock.query('COMMIT');
      const policy = await decision;
      expect(policy.decision).toBe('ask');
      expect(policy.reasons.join(' ')).toContain('owned by agent');
    } finally {
      await lock.query('ROLLBACK').catch(() => {});
      lock.release();
    }
  });
});
