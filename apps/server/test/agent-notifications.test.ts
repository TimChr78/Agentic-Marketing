import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgentNotificationsOnce } from '../src/agents/notifications';
import { startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 18 (#226): the sponsor and a mandate's escalation targets hear about holds,
// guardrail/limit escalations, refusals and an expiring mandate; allows wait for the daily digest.
// The job is driven directly with a clock, like the alert tests, so no test waits for a tick.

const PORT = testPort(3490);
const DAY = 86_400_000;

let t: Awaited<ReturnType<typeof startTestServer>>;

const deps = () => ({
  db: t.srv.db,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});
const run = (now = new Date()) => runAgentNotificationsOnce(deps(), now);
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const agentCall = async (token: string, name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

interface Setup {
  owner: User;
  viewer?: User;
  ws: string;
  token: string;
  agentId: string;
  api: ReturnType<typeof t.api>;
}

let unique = 0;

/**
 * The cursor of a workspace that already ran the job before any agent action: the feature exists,
 * so later actions are announced. Without it, the first run starts at the current head (#266).
 */
async function primeCursor(ws: string) {
  await t.srv.db.admin.query('INSERT INTO agent_notification_cursor (workspace_id, last_action_id) VALUES ($1, 0)', [ws]);
}

/** A fresh workspace with one agent, its sponsor and (optionally) an escalation target. */
async function setup(
  opts: { level: number; escalation?: boolean; validUntil?: string; provider?: boolean; prime?: boolean } = { level: 1 },
): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-agent-notifications-${n}-${Date.now()}@example.com`);
  const viewer = opts.escalation ? await t.signUp(`escalation-agent-notifications-${n}-${Date.now()}@example.com`) : undefined;
  const ws = await t.workspaceWith([[owner, 'owner'], ...(viewer ? ([[viewer, 'viewer']] as [User, string][]) : [])], 'none');
  const api = t.api(owner, ws);
  if (opts.provider !== false)
    await api.call('emailProviders.create', {
      name: 'Outbox',
      adapter: 'log',
      fromEmail: 'agents@example.com',
      useFor: ['transactional'],
    });
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', {
      name: 'Notified agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Notification mandate',
    content: {
      agent: agentId,
      purpose: 'Test how a person is told about an agent’s actions',
      validUntil: opts.validUntil ?? inDays(30),
      levels: { 'content.publish': opts.level },
      escalation: { userIds: viewer ? [viewer.id] : [] },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  if (opts.prime !== false) await primeCursor(ws);
  return { owner, viewer, ws, token, agentId, api };
}

const cursorOf = async (ws: string) =>
  Number(
    (
      await t.srv.db.admin.query<{ last_action_id: string }>(
        'SELECT last_action_id FROM agent_notification_cursor WHERE workspace_id = $1',
        [ws],
      )
    ).rows[0].last_action_id,
  );

const latestActionId = async (ws: string) =>
  Number((await t.srv.db.admin.query<{ id: string }>('SELECT max(id) AS id FROM agent_actions WHERE workspace_id = $1', [ws])).rows[0].id);

/** An agent drafts a note and submits it, exercising content.publish through the policy engine. */
async function publishNote(s: Setup, title: string) {
  const created = await agentCall(s.token, 'artifacts.create', {
    type: 'note',
    name: title,
    content: { title, body: 'A note from the agent under test.' },
  });
  expect(created.status).toBe(200);
  return agentCall(s.token, 'artifacts.requestPublish', {
    artifactId: created.body.artifactId,
    note: `${title}: what the agent intends to do`,
  });
}

const emailRows = async (ws: string, prefix: string) =>
  (
    await t.srv.db.admin.query<{ status: string; idempotency_key: string }>(
      'SELECT status, idempotency_key FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE $2 ORDER BY created_at',
      [ws, `${prefix}%`],
    )
  ).rows;

beforeAll(async () => {
  t = await startTestServer('test_agent_notifications', PORT);
}, 90_000);

beforeEach(() => {
  outbox.length = 0;
});

afterAll(async () => {
  await t?.close();
});

describe('agent notifications (#226)', () => {
  it('a held action e-mails the sponsor once with the run time and the approval link', async () => {
    const s = await setup({ level: 2, escalation: true });
    const held = await publishNote(s, 'Held issue');
    expect(held.body.status).toBe('on_hold');
    expect(held.body.runsAt).toBeTruthy();

    const first = await run();
    expect(first.events).toBeGreaterThanOrEqual(2); // sponsor and escalation target
    const toSponsor = outbox.filter((m) => m.to === s.owner.email);
    const toViewer = outbox.filter((m) => m.to === s.viewer!.email);
    expect(toSponsor.filter((m) => m.subject.startsWith('Held:'))).toHaveLength(1);
    expect(toViewer.filter((m) => m.subject.startsWith('Held:'))).toHaveLength(1);
    const heldMail = toSponsor.find((m) => m.subject.startsWith('Held:'))!;
    expect(heldMail.text).toContain(`It runs at ${held.body.runsAt}`);
    expect(heldMail.text).toContain(`/approvals/${held.body.approvalId}`);
    expect(heldMail.text).toContain(`/settings/agents/${s.agentId}`);
    expect(heldMail.html).toContain(`/approvals/${held.body.approvalId}`);

    // The cursor makes the next run silent, so the sponsor has exactly one message for the hold.
    expect((await run()).events).toBe(0);
    expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Held:'))).toHaveLength(1);
    expect(outbox.filter((m) => m.to === s.viewer!.email && m.subject.startsWith('Held:'))).toHaveLength(1);
    const rows = await emailRows(s.ws, 'agent-event:');
    expect(rows.filter((r) => r.idempotency_key.endsWith(s.owner.id))).toHaveLength(1);
    expect(rows.filter((r) => r.idempotency_key.endsWith(s.viewer!.id))).toHaveLength(1);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
  }, 30_000);

  it('three refusals in a burst produce one e-mail', async () => {
    const s = await setup({ level: 0 });
    for (const title of ['First', 'Second', 'Third']) {
      const refused = await publishNote(s, title);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toContain('level 0');
    }

    const first = await run();
    expect(first.events).toBe(1);
    const eventMails = outbox.filter((m) => m.to === s.owner.email && m.subject.includes('changes need your attention'));
    expect(eventMails).toHaveLength(1);
    expect(eventMails[0].text.match(/Refused:/g)).toHaveLength(3);
    expect(eventMails[0].text).toContain('First');
    expect(eventMails[0].text).toContain('Second');
    expect(eventMails[0].text).toContain('Third');
    expect(await emailRows(s.ws, 'agent-event:')).toHaveLength(1);

    // A burst that already went out is not re-sent on the next sweep.
    expect((await run()).events).toBe(0);
    expect(await emailRows(s.ws, 'agent-event:')).toHaveLength(1);
  }, 30_000);

  it('the daily digest goes out once a day per sponsor', async () => {
    const s = await setup({ level: 3 });
    const t0 = new Date();
    for (const title of ['Autonomous one', 'Autonomous two']) {
      const published = await publishNote(s, title);
      expect(published.body.status).toBe('published');
    }

    const first = await run(t0);
    expect(first.digests).toBeGreaterThanOrEqual(1);
    const firstDigest = outbox.find((m) => m.to === s.owner.email && m.subject.startsWith('Daily agent digest'))!;
    expect(firstDigest).toBeTruthy();
    expect(firstDigest.text).toContain('2 allowed');
    expect(firstDigest.text).toContain('Ran autonomously');
    expect(firstDigest.text).toContain('Autonomous one: what the agent intends to do');
    expect(firstDigest.text).toContain(`/settings/agents/${s.agentId}`);
    expect(await emailRows(s.ws, 'agent-digest:')).toHaveLength(1);

    // New activity an hour later must wait for the next day: one digest per sponsor per day.
    expect((await publishNote(s, 'Later activity')).body.status).toBe('published');
    expect((await run(new Date(t0.getTime() + 3_600_000))).digests).toBe(0);
    expect(await emailRows(s.ws, 'agent-digest:')).toHaveLength(1);

    // A day later, with activity, the sponsor gets the next digest. The new action is stamped
    // inside that run's 24-hour window, so the test controls the clock without waiting.
    expect((await publishNote(s, 'Next day activity')).body.status).toBe('published');
    const { rows: latest } = await t.srv.db.admin.query<{ id: number }>(
      'SELECT max(id) AS id FROM agent_actions WHERE workspace_id = $1 AND agent_id = $2',
      [s.ws, s.agentId],
    );
    await t.srv.db.admin.query('UPDATE agent_actions SET at = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      new Date(t0.getTime() + DAY),
      latest[0].id,
    ]);
    const next = await run(new Date(t0.getTime() + DAY + 60_000));
    expect(next.digests).toBeGreaterThanOrEqual(1);
    expect(await emailRows(s.ws, 'agent-digest:')).toHaveLength(2);
  }, 40_000);

  it('the expiry notice goes once', async () => {
    const s = await setup({ level: 1, validUntil: inDays(2) });
    const first = await run();
    expect(first.expiries).toBeGreaterThanOrEqual(1);
    const expiry = outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Mandate for'));
    expect(expiry).toHaveLength(1);
    expect(expiry[0].text).toContain('expires');
    expect(expiry[0].text).toContain(`/settings/agents/${s.agentId}`);
    expect(await emailRows(s.ws, 'agent-expiry:')).toHaveLength(1);

    expect((await run()).expiries).toBe(0);
    expect(await emailRows(s.ws, 'agent-expiry:')).toHaveLength(1);
    expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Mandate for'))).toHaveLength(1);
  }, 30_000);

  it('a workspace upgraded with an existing ledger is not replayed', async () => {
    // The first run creates the cursor at the current head: everything already in the ledger
    // predates the feature and must stay silent.
    const s = await setup({ level: 2, prime: false });
    const held = await publishNote(s, 'Before notifications existed');
    expect(held.body.status).toBe('on_hold');
    const head = await latestActionId(s.ws);

    const first = await run();
    expect(first.events).toBe(0);
    expect(outbox.filter((m) => m.to === s.owner.email)).toHaveLength(0);
    expect(await emailRows(s.ws, 'agent-event:')).toHaveLength(0);
    expect(await cursorOf(s.ws)).toBe(head);

    // The held action is still visible to a person in the agent activity; it is just not e-mailed.
    const { actions } = await s.api.call('agents.activity', { agentId: s.agentId, limit: 5 });
    expect(actions.some((a: { decision: string }) => a.decision === 'hold')).toBe(true);
  }, 30_000);

  it('a failed notification is retried once a provider exists', async () => {
    // No transactional provider: the send fails, so the cursor stops before the action instead of
    // swallowing it. The retry reuses the same idempotency key, so the sponsor gets exactly one mail.
    const s = await setup({ level: 2, provider: false, prime: true });
    const held = await publishNote(s, 'Needs a provider');
    expect(held.body.status).toBe('on_hold');
    const actionId = await latestActionId(s.ws);

    const failed = await run();
    expect(failed.events).toBe(0);
    expect(await cursorOf(s.ws)).toBeLessThan(actionId);
    expect(await emailRows(s.ws, 'agent-event:')).toHaveLength(0);

    await s.api.call('emailProviders.create', {
      name: 'Outbox',
      adapter: 'log',
      fromEmail: 'agents@example.com',
      useFor: ['transactional'],
    });
    const retried = await run();
    expect(retried.events).toBe(1);
    expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Held:'))).toHaveLength(1);
    const rows = await emailRows(s.ws, 'agent-event:');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(await cursorOf(s.ws)).toBeGreaterThanOrEqual(actionId);

    // The action was announced exactly once: a later sweep neither advances past a failure nor re-sends.
    expect((await run()).events).toBe(0);
    expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Held:'))).toHaveLength(1);
    expect(await emailRows(s.ws, 'agent-event:')).toHaveLength(1);
  }, 30_000);
});
