import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 19 (ADR-0016 §5.4, #255): the ledger keeps how to reverse an agent's action and
// agents.undo runs it — republish the previous version, unpublish a first publish, cancel a
// scheduled broadcast. A send that already happened cannot be undone, and the ledger says so.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let agentId = '';
let templateId = '';
let segmentId = '';

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  t = await startTestServer('test_agent_undo', testPort(3499));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // agent_changes: without a mandate, every agent publish waits for a person.
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
    label: 'Undo test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const seg = await api.call('artifacts.create', { type: 'segment', name: 'News', content: { condition: { consent: 'marketing_email' } } });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'setup' });
  segmentId = seg.artifactId;
  await eventually(
    () => api.call('segments.refresh', { artifactId: segmentId }),
    (r) => r.members === 3,
  );
  token = (
    await api.call('apiTokens.create', {
      name: 'Newsletter agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send', 'audit:read'],
    })
  ).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
  // A person grants level 3 for content and broadcasts to the newsletter segment.
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Newsletter mandate',
    content: {
      agent: agentId,
      purpose: 'Send the weekly newsletter',
      validUntil: inDays(30),
      scope: { segments: [segmentId], purposes: ['marketing_email'], channels: ['email'] },
      levels: { 'content.publish': 3, 'send.broadcast': 3 },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
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

/** The newest ledger entry for an artifact, as a person sees it in agents.activity. */
async function actionFor(artifactId: string, actionClass?: string) {
  const { actions } = await t.api(owner).call('agents.activity', {
    agentId,
    limit: 50,
    ...(actionClass ? { actionClass } : {}),
  });
  const action = actions.find((a) => a.target === artifactId && a.command === 'artifacts.requestPublish');
  expect(action, `no ledger entry for ${artifactId}`).toBeTruthy();
  return action!;
}

let contentActionId = 0;

describe('publishing content', () => {
  it('an agent publishes v2 itself; undo republishes v1 and records it', async () => {
    const api = t.api(owner);
    const tpl = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Weekly issue',
      content: { purpose: 'marketing_email', subject: 'v1', mjml },
    });
    await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'v1' });
    await call('artifacts.updateDraft', {
      artifactId: tpl.artifactId,
      content: { purpose: 'marketing_email', subject: 'v2', mjml },
      note: 'A sharper subject',
    });
    const published = await call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'v2 from the agent' });
    expect(published.body).toMatchObject({ status: 'published', version: 2 });

    const action = await actionFor(tpl.artifactId, 'content.publish');
    expect(action.undoable).toBe(true);
    expect(action.undoneAt).toBeNull();
    expect(action.undo).toMatchObject({ kind: 'republish', artifactId: tpl.artifactId, previousVersion: 1 });

    contentActionId = action.id;
    const undone = await api.call('agents.undo', { actionId: action.id, note: 'Subject tested worse' });
    expect(undone.result).toContain('Republished');
    expect(undone.steps.join(' ')).toContain(`Republished ${tpl.artifactId} v1`);
    expect((await api.call('artifacts.get', { artifactId: tpl.artifactId })).publishedVersion).toBe(1);

    const { rows } = await t.srv.db.admin.query('SELECT undone_at, undone_by, undo_result FROM agent_actions WHERE id = $1', [action.id]);
    expect(rows[0].undone_by).toBe(owner.id);
    expect(rows[0].undone_at).not.toBeNull();
    expect(rows[0].undo_result).toContain('Republished');
    expect(rows[0].undo_result).toContain('Subject tested worse');

    const after = await actionFor(tpl.artifactId, 'content.publish');
    expect(after).toMatchObject({ id: action.id, undoable: false });
    expect(after.undoneAt).not.toBeNull();
  });

  it('undoing a first publish takes it out of service again', async () => {
    const api = t.api(owner);
    const created = await call('artifacts.create', {
      type: 'email_template',
      name: 'First issue',
      content: { purpose: 'marketing_email', subject: 'Fresh', mjml },
    });
    const published = await call('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'First publish' });
    expect(published.body).toMatchObject({ status: 'published', version: 1 });

    const action = await actionFor(created.body.artifactId, 'content.publish');
    expect(action.undo).toMatchObject({ kind: 'republish', artifactId: created.body.artifactId, previousVersion: null });

    const undone = await api.call('agents.undo', { actionId: action.id });
    expect(undone.result).toContain('Unpublished');
    expect((await api.call('artifacts.get', { artifactId: created.body.artifactId })).publishedVersion).toBeNull();
    const { rows } = await t.srv.db.admin.query('SELECT state FROM artifact_versions WHERE artifact_id = $1 AND number = 1', [
      created.body.artifactId,
    ]);
    expect(rows[0].state).toBe('draft');
  });

  it('undoing twice is refused', async () => {
    await expect(t.api(owner).call('agents.undo', { actionId: contentActionId })).rejects.toMatchObject({
      message: expect.stringContaining('already undone'),
    });
  });

  it('an agent cannot undo: only a person can', async () => {
    const out = await call('agents.undo', { actionId: contentActionId });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('can only be run by a person');
  });
});

describe('broadcasts', () => {
  it('a scheduled broadcast that has not gone out is cancelled by undo', async () => {
    const api = t.api(owner);
    const bcast = await call('artifacts.create', {
      type: 'broadcast',
      name: 'Scheduled issue',
      content: { template: templateId, segment: segmentId, sendAt: inHours(1) },
    });
    const published = await call('artifacts.requestPublish', { artifactId: bcast.body.artifactId, note: 'Tomorrow’s issue' });
    expect(published.body).toMatchObject({ status: 'published', version: 1 });

    const action = await actionFor(bcast.body.artifactId, 'send.broadcast');
    expect(action.undoable).toBe(true);
    expect(action.undo).toMatchObject({
      kind: 'group',
      items: [
        { kind: 'republish', artifactId: bcast.body.artifactId, previousVersion: null },
        { kind: 'cancel_send', broadcastId: bcast.body.artifactId },
      ],
    });

    const scheduled = await eventually(
      () => api.call('broadcasts.status', { artifactId: bcast.body.artifactId }),
      (r) => r.run.status === 'scheduled',
    );
    expect(scheduled.run.status).toBe('scheduled');
    // As if it were a staged send waiting on its canary (#287).
    await t.srv.db.admin.query(
      `INSERT INTO broadcast_stages (workspace_id, broadcast_id, stage, canary_percent)
       SELECT workspace_id, broadcast_id, 'canary_waiting', 10 FROM broadcast_runs WHERE broadcast_id = $1`,
      [bcast.body.artifactId],
    );

    const undone = await api.call('agents.undo', { actionId: action.id });
    expect(undone.result).toContain('Cancelled the scheduled send');
    const status = await api.call('broadcasts.status', { artifactId: bcast.body.artifactId });
    expect(status.run.status).toBe('cancelled');
    const { rows: stages } = await t.srv.db.admin.query('SELECT stage, stop_reason FROM broadcast_stages WHERE broadcast_id = $1', [
      bcast.body.artifactId,
    ]);
    expect(stages[0]).toMatchObject({ stage: 'stopped', stop_reason: expect.stringContaining('Undone') });
    // It was the first publish: undo takes it out of service again too.
    expect((await api.call('artifacts.get', { artifactId: bcast.body.artifactId })).publishedVersion).toBeNull();
  });

  it('a broadcast that already went out cannot be undone', async () => {
    const api = t.api(owner);
    const bcast = await call('artifacts.create', {
      type: 'broadcast',
      name: 'Sent issue',
      content: { template: templateId, segment: segmentId },
    });
    const published = await call('artifacts.requestPublish', { artifactId: bcast.body.artifactId, note: 'Send now' });
    expect(published.body.status).toBe('published');
    const action = await actionFor(bcast.body.artifactId, 'send.broadcast');
    await eventually(
      () => api.call('broadcasts.status', { artifactId: bcast.body.artifactId }),
      (r) => r.run.status === 'done',
      30_000,
    );
    await expect(api.call('agents.undo', { actionId: action.id })).rejects.toMatchObject({
      message: expect.stringContaining('Messages already sent cannot be recalled.'),
    });
    // The refusal changed nothing.
    await expect(api.call('agents.undo', { actionId: action.id })).rejects.toBeTruthy();
    expect((await api.call('artifacts.get', { artifactId: bcast.body.artifactId })).publishedVersion).toBe(1);
  });
});
