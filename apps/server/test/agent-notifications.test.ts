import { outbox } from '@agentic-marketing/email';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { digestWindowsQuery, runAgentNotificationsOnce } from '../src/agents/notifications';
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

/**
 * A cursor whose last digest went out a day before `now`, so the next sweep is due and the digest
 * window starts at a time the test controls (#1184).
 */
async function primeDigestDue(ws: string, now: Date) {
  await t.srv.db.admin.query('UPDATE agent_notification_cursor SET last_digest_at = $2 WHERE workspace_id = $1', [
    ws,
    new Date(now.getTime() - DAY),
  ]);
}

/** A fresh workspace with one agent, its sponsor and (optionally) an escalation target. */
async function setup(
  opts: {
    level: number;
    escalation?: boolean;
    /** An escalation target who is not a member: the send to them fails while the sponsor still gets mail. */
    escalationUserId?: string;
    validUntil?: string;
    provider?: boolean;
    prime?: boolean;
  } = { level: 1 },
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
      escalation: { userIds: opts.escalationUserId ? [opts.escalationUserId] : viewer ? [viewer.id] : [] },
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
async function publishNoteWith(token: string, title: string) {
  const created = await agentCall(token, 'artifacts.create', {
    type: 'note',
    name: title,
    content: { title, body: 'A note from the agent under test.' },
  });
  expect(created.status).toBe(200);
  return agentCall(token, 'artifacts.requestPublish', {
    artifactId: created.body.artifactId,
    note: `${title}: what the agent intends to do`,
  });
}

const publishNote = (s: Setup, title: string) => publishNoteWith(s.token, title);

/** A second agent in the same workspace, on its own token and mandate. */
async function addAgent(s: Setup, opts: { name: string; level?: number; escalationUserId?: string } = { name: 'Second agent' }) {
  const token = (
    await s.api.call('apiTokens.create', {
      name: opts.name,
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token as string;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  await s.api.call('agents.update', { id: agentId, name: opts.name });
  const mandate = await s.api.call('artifacts.create', {
    type: 'agent_mandate',
    name: `${opts.name} mandate`,
    content: {
      agent: agentId,
      purpose: 'Test notifications for a second agent in one workspace',
      validUntil: inDays(30),
      levels: { 'content.publish': opts.level ?? 3 },
      escalation: { userIds: opts.escalationUserId ? [opts.escalationUserId] : [] },
    } as never,
  });
  expect((await s.api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { token, agentId };
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
    expect(heldMail.text).toContain(`/work/agents/${s.agentId}`);
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
    // A clock just after the activity: a digest window ends at the pass's own time, so the actions
    // published above are inside it. A fixed date in the past would leave them in the future.
    const t0 = new Date(Date.now() + 1000);
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
    expect(firstDigest.text).toContain(`/work/agents/${s.agentId}`);
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
    expect(expiry[0].text).toContain(`/work/agents/${s.agentId}`);
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

  it('a retry after a delivery webhook sends only to the recipient whose mail failed (#round 3)', async () => {
    // Owner A gets the digest, owner B's send fails. The provider's delivery webhook then marks A's
    // message `delivered`. A retry must not treat that as a failed send and mail A again.
    const s = await setup({ level: 3 });
    const second = await addAgent(s, { name: 'Webhook retry agent', level: 3 });
    const outsider = await t.signUp(`outsider-webhook-retry-${Date.now()}@example.com`);
    await t.srv.db.admin.query('UPDATE agents SET sponsor_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      outsider.id,
      second.agentId,
    ]);
    expect((await publishNote(s, 'Digest for the owner')).body.status).toBe('published');
    expect((await publishNoteWith(second.token, 'Digest for the outsider')).body.status).toBe('published');

    const ownerDigests = () => outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Daily agent digest'));
    const outsiderDigests = () => outbox.filter((m) => m.to === outsider.email && m.subject.startsWith('Daily agent digest'));

    // A clock after the two actions: the window ends at the pass's own time.
    const t0 = new Date(Date.now() + 1000);
    await primeDigestDue(s.ws, t0);
    expect((await run(t0)).digests).toBe(1);
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(0);

    // What a SendGrid/Postmark delivery event does: the message row becomes `delivered`.
    await t.srv.db.admin.query(`UPDATE messages SET status = 'delivered' WHERE workspace_id = $1 AND idempotency_key LIKE $2`, [
      s.ws,
      `agent-digest:${s.ws}:${s.owner.id}:%`,
    ]);
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      s.ws,
      outsider.id,
      'viewer',
    ]);
    const retry = await run(new Date(t0.getTime() + 5 * 60_000));
    expect(retry.digests).toBe(1);
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(1);
    const rows = await emailRows(s.ws, 'agent-digest:');
    expect(rows.map((r) => r.status).sort()).toEqual(['delivered', 'sent']);
  }, 40_000);

  it('interleaved agents deliver each action once when one agent cannot be reached (#276)', async () => {
    const s = await setup({ level: 2 });
    await s.api.call('agents.update', { id: s.agentId, name: 'Interleaved X' });
    const outsider = await t.signUp(`outsider-interleaved-${Date.now()}@example.com`);
    const y = await addAgent(s, { name: 'Interleaved Y', level: 2, escalationUserId: outsider.id });

    expect((await publishNote(s, 'Interleaved X one')).body.status).toBe('on_hold');
    expect((await publishNoteWith(y.token, 'Interleaved Y one')).body.status).toBe('on_hold');
    expect((await publishNote(s, 'Interleaved X two')).body.status).toBe('on_hold');

    const xMails = () =>
      outbox.filter((m) => m.to === s.owner.email && m.subject.includes('Interleaved X') && !m.subject.startsWith('Daily agent digest'));
    const first = await run();
    expect(first.events).toBeGreaterThanOrEqual(2);
    // X's two actions are one batch, each listed exactly once.
    expect(xMails()).toHaveLength(1);
    expect(xMails()[0].text.match(/Interleaved X one/g)).toHaveLength(1);
    expect(xMails()[0].text.match(/Interleaved X two/g)).toHaveLength(1);

    // Y's batch stays pending for the outsider. The retry sees the same X actions, but delivery is
    // recorded per action and recipient, so X's sponsor gets nothing more.
    await run();
    expect(xMails()).toHaveLength(1);
  }, 40_000);

  it('a new action after a failure does not re-send what the sponsor already received (#276)', async () => {
    const outsider = await t.signUp(`outsider-new-action-${Date.now()}@example.com`);
    const s = await setup({ level: 2, escalationUserId: outsider.id });
    expect((await publishNote(s, 'Before the failure')).body.status).toBe('on_hold');

    const sponsorEvents = () => outbox.filter((m) => m.to === s.owner.email && !m.subject.startsWith('Daily agent digest'));
    await run();
    expect(sponsorEvents()).toHaveLength(1); // sponsor delivered, outsider still pending
    expect(sponsorEvents()[0].text).toContain('Before the failure');

    // The new action changes the batch, but the first action was already delivered to the sponsor.
    expect((await publishNote(s, 'After the failure')).body.status).toBe('on_hold');
    await run();
    expect(sponsorEvents()).toHaveLength(2);
    expect(sponsorEvents().filter((m) => m.text.includes('Before the failure'))).toHaveLength(1);
    expect(sponsorEvents().filter((m) => m.text.includes('After the failure'))).toHaveLength(1);
  }, 40_000);

  it('a digest that fails for one sponsor is retried without re-sending the other (#277)', async () => {
    const s = await setup({ level: 3 });
    const second = await addAgent(s, { name: 'Second digest agent', level: 3 });
    // The second agent's sponsor is not a member yet: the send fails while the first sponsor's works.
    const outsider = await t.signUp(`outsider-digest-${Date.now()}@example.com`);
    await t.srv.db.admin.query('UPDATE agents SET sponsor_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      outsider.id,
      second.agentId,
    ]);
    expect((await publishNote(s, 'Digest for the owner')).body.status).toBe('published');
    expect((await publishNoteWith(second.token, 'Digest for the outsider')).body.status).toBe('published');

    const ownerDigests = () => outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Daily agent digest'));
    const outsiderDigests = () => outbox.filter((m) => m.to === outsider.email && m.subject.startsWith('Daily agent digest'));

    // A clock after the two actions: the window ends at the pass's own time.
    const t0 = new Date(Date.now() + 1000);
    await primeDigestDue(s.ws, t0);
    const first = await run(t0);
    expect(first.digests).toBe(1); // only the owner's digest went out
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(0);

    // The outsider joins the workspace. The next sweep retries only that sponsor's digest; the
    // owner's already-sent message row keeps it from being sent a second time.
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      s.ws,
      outsider.id,
      'viewer',
    ]);
    const retry = await run(new Date(t0.getTime() + 5 * 60_000));
    expect(retry.digests).toBe(1);
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(1);
    expect(outsiderDigests()[0].text).toContain('Digest for the outsider');
    const rows = await emailRows(s.ws, 'agent-digest:');
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(2);

    // The day is complete now, so the sweep after that is silent.
    expect((await run(new Date(t0.getTime() + 10 * 60_000))).digests).toBe(0);
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(1);
  }, 40_000);

  it('a digest retried a few minutes later sends only to the sponsor whose mail failed (#1184)', async () => {
    // A partial failure keeps the digest window open. The retry belongs to the same window even
    // when it runs later, so it must not re-send the digest to the sponsor who got it.
    const s = await setup({ level: 3 });
    const second = await addAgent(s, { name: 'Retried digest agent', level: 3 });
    // The second agent's sponsor is not a member yet: the send fails while the first sponsor's works.
    const outsider = await t.signUp(`outsider-digest-midnight-${Date.now()}@example.com`);
    await t.srv.db.admin.query('UPDATE agents SET sponsor_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      outsider.id,
      second.agentId,
    ]);
    expect((await publishNote(s, 'Digest before the retry')).body.status).toBe('published');
    expect((await publishNoteWith(second.token, 'Digest for the outsider')).body.status).toBe('published');

    // Both clocks are after the two actions: a window ends at the pass's own time.
    const lateNight = new Date(Date.now() + 1000);
    const afterMidnight = new Date(lateNight.getTime() + 5 * 60_000);
    await primeDigestDue(s.ws, lateNight);

    const ownerDigests = () => outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Daily agent digest'));
    const outsiderDigests = () => outbox.filter((m) => m.to === outsider.email && m.subject.startsWith('Daily agent digest'));

    const first = await run(lateNight);
    expect(first.digests).toBe(1); // only the owner's digest went out
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(0);

    // The retry of the same window, a few minutes later, reaches only the sponsor whose mail failed.
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      s.ws,
      outsider.id,
      'viewer',
    ]);
    const retry = await run(afterMidnight);
    expect(retry.digests).toBe(1);
    expect(ownerDigests()).toHaveLength(1);
    expect(outsiderDigests()).toHaveLength(1);
    expect(outsiderDigests()[0].text).toContain('Digest for the outsider');
    const rows = await emailRows(s.ws, 'agent-digest:');
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(2);

    // The window completed with the retry, so the next day's digest still goes out normally, for
    // both sponsors. Each action is stamped inside that window, so the test controls the clock.
    const beforeNextDay = await latestActionId(s.ws);
    expect((await publishNote(s, 'Next day activity')).body.status).toBe('published');
    expect((await publishNoteWith(second.token, 'Next day for the outsider')).body.status).toBe('published');
    const nextDay = new Date(lateNight.getTime() + DAY + 5 * 60_000);
    await t.srv.db.admin.query('UPDATE agent_actions SET at = $2 WHERE workspace_id = $1 AND id > $3', [s.ws, nextDay, beforeNextDay]);
    const next = await run(new Date(nextDay.getTime() + 60_000));
    expect(next.digests).toBeGreaterThanOrEqual(1);
    expect(ownerDigests()).toHaveLength(2);
    expect(outsiderDigests()).toHaveLength(2);
    expect(outsiderDigests()[1].text).toContain('Next day for the outsider');
    expect(await emailRows(s.ws, 'agent-digest:')).toHaveLength(4);
  }, 40_000);

  it('a sponsor who can never be mailed does not stop the other sponsors’ daily digests (#1227)', async () => {
    // A removed member stays the sponsor of an agent (`members.remove` leaves `agents.sponsor_user_id`),
    // and `sendMemberEmails` refuses that address for good. Since the #1184 fix a failed sponsor kept
    // the whole digest window open, so nobody else got another digest.
    const s = await setup({ level: 3 });
    const second = await addAgent(s, { name: 'Departed sponsor agent', level: 3 });
    const departed = await t.signUp(`departed-digest-${Date.now()}@example.com`);
    await t.srv.db.admin.query('UPDATE agents SET sponsor_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      departed.id,
      second.agentId,
    ]);
    expect((await publishNote(s, 'Day 1 for the owner')).body.status).toBe('published');
    expect((await publishNoteWith(second.token, 'Day 1 for the departed sponsor')).body.status).toBe('published');

    const ownerDigests = () => outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Daily agent digest'));
    const departedDigests = () => outbox.filter((m) => m.to === departed.email && m.subject.startsWith('Daily agent digest'));
    const lastDigestAt = async () =>
      (
        await t.srv.db.admin.query<{ last_digest_at: Date | null }>(
          'SELECT last_digest_at FROM agent_notification_cursor WHERE workspace_id = $1',
          [s.ws],
        )
      ).rows[0]?.last_digest_at;

    // A clock after Day 1's two actions: the window ends at the pass's own time.
    const t0 = new Date(Date.now() + 1000);
    await primeDigestDue(s.ws, t0);
    expect((await run(t0)).digests).toBe(1); // the owner's digest went out; the departed sponsor has no mailbox here
    expect(ownerDigests()).toHaveLength(1);
    expect(departedDigests()).toHaveLength(0);

    // A day later the owner's agent acted again: the owner is due a digest for the new activity.
    // The action is stamped inside the second window, so the test controls the clock.
    expect((await publishNote(s, 'Day 2 for the owner')).body.status).toBe('published');
    const t1 = new Date(t0.getTime() + DAY);
    await t.srv.db.admin.query('UPDATE agent_actions SET at = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      new Date(t0.getTime() + 60_000),
      await latestActionId(s.ws),
    ]);
    expect((await run(t1)).digests).toBeGreaterThanOrEqual(1);
    expect(ownerDigests()).toHaveLength(2);
    expect((await lastDigestAt())?.toISOString()).toBe(t1.toISOString());

    // ... and three days later still, with more activity.
    expect((await publishNote(s, 'Day 5 for the owner')).body.status).toBe('published');
    await t.srv.db.admin.query('UPDATE agent_actions SET at = $2 WHERE workspace_id = $1 AND id = $3', [
      s.ws,
      new Date(t0.getTime() + 2 * DAY),
      await latestActionId(s.ws),
    ]);
    await run(new Date(t0.getTime() + 4 * DAY));
    expect(ownerDigests()).toHaveLength(3);
  }, 60_000);

  it('a recipient who is not a member does not hold the event cursor before later holds (#1234)', async () => {
    // The mandate's escalation target is not a member of the workspace: the send to them can never
    // succeed. The cursor must pass that action once the sponsor was reached, or after 500 newer
    // ledger rows every later hold, ask and refusal is outside the window the sweep reads.
    const departed = await t.signUp(`departed-escalation-${Date.now()}@example.com`);
    const s = await setup({ level: 2, escalationUserId: departed.id });
    expect((await publishNote(s, 'Held one')).body.status).toBe('on_hold');
    const first = await run();
    const heldMails = () => outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Held:'));
    expect(first.events).toBeGreaterThanOrEqual(1);
    expect(heldMails()).toHaveLength(1);
    const heldOne = Number(
      (
        await t.srv.db.admin.query<{ id: string }>(
          "SELECT max(id) AS id FROM agent_actions WHERE workspace_id = $1 AND decision = 'hold'",
          [s.ws],
        )
      ).rows[0].id,
    );
    expect(await cursorOf(s.ws)).toBeGreaterThanOrEqual(heldOne);

    // 505 more ledger rows for this workspace (an active agent's drafts and allows).
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
       SELECT $1, $2, 'artifacts.create', 'draft', 'allow', true, 'rest' FROM generate_series(1, 505)`,
      [s.ws, s.agentId],
    );
    // A new hold by the same agent; its sponsor is a member and reachable.
    expect((await publishNote(s, 'Held two')).body.status).toBe('on_hold');
    const second = await run();
    expect(second.events).toBeGreaterThanOrEqual(1);
    expect(heldMails()).toHaveLength(2);
    expect(heldMails().some((m) => m.text.includes('Held two'))).toBe(true);
  }, 60_000);
});

// PR 1272 review: the digest window must survive an upgrade from the previous release, a provider
// that is not set up yet, and a retry; the event sweep must read the decisions it announces past
// denied drafts; and the newest-row lookup must not scan the workspace's digest history.
describe('PR 1272 review regressions', () => {
  const digestMessages = (user: User) => outbox.filter((m) => m.to === user.email && m.subject.startsWith('Daily agent digest'));
  const markAt = (ws: string, actionId: number, at: Date) =>
    t.srv.db.admin.query('UPDATE agent_actions SET at = $1 WHERE workspace_id = $2 AND id = $3', [at, ws, actionId]);

  /** A digest row in the previous release's shape: the key is the window start, no window metadata. */
  const legacyDigest = async (s: Setup, started: Date, status: 'sent' | 'failed', completed: Date, keyShape: 'iso' | 'day' = 'iso') => {
    // Releases before #1184 keyed the digest by UTC day; the previous release by the window start.
    const suffix = keyShape === 'day' ? started.toISOString().slice(0, 10) : started.toISOString();
    const key = `agent-digest:${s.ws}:${s.owner.id}:${suffix}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, purpose, status, created_at, updated_at)
       VALUES ($1, 'msg_review_legacy', $2, 'onboarding', $3, $4, $4)`,
      [s.ws, key, status, completed],
    );
    return key;
  };

  it('retries a first digest after a transactional provider becomes available', async () => {
    const s = await setup({ level: 3, provider: false });
    expect((await publishNote(s, 'Activity during outage')).body.status).toBe('published');
    const t0 = new Date(Date.now() + 1000);
    await primeDigestDue(s.ws, t0);
    await run(t0);
    expect(digestMessages(s.owner)).toHaveLength(0);
    await s.api.call('emailProviders.create', {
      name: 'Restored outbox',
      adapter: 'log',
      fromEmail: 'agents@example.com',
      useFor: ['transactional'],
    });
    await run(new Date(t0.getTime() + 300_000));
    expect(digestMessages(s.owner)).toHaveLength(1);
    expect(digestMessages(s.owner)[0].text).toContain('Activity during outage');
  }, 40_000);

  it('closes a retried digest at the end of the window it actually sent', async () => {
    // The first attempt fails (the sponsor is not a member yet). The retry succeeds an hour later
    // and covers activity up to that moment. If the row kept the failed attempt's window end, the
    // next window would start before the activity the retry already reported.
    const s = await setup({ level: 3 });
    const outsider = await t.signUp(`retry-window-${Date.now()}@example.com`);
    await t.srv.db.admin.query('UPDATE agents SET sponsor_user_id = $1 WHERE workspace_id = $2 AND id = $3', [
      outsider.id,
      s.ws,
      s.agentId,
    ]);
    expect((await publishNote(s, 'Before first failed attempt')).body.status).toBe('published');
    const t0 = new Date(Date.now() + 1000);
    await primeDigestDue(s.ws, t0);
    await run(t0);
    expect(await emailRows(s.ws, 'agent-digest:')).toMatchObject([{ status: 'failed' }]);
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,$3)', [
      s.ws,
      outsider.id,
      'viewer',
    ]);
    expect((await publishNote(s, 'Already included on retry')).body.status).toBe('published');
    await markAt(s.ws, await latestActionId(s.ws), new Date(t0.getTime() + 300_000));
    await run(new Date(t0.getTime() + 600_000));
    expect(digestMessages(outsider)).toHaveLength(1);
    expect(digestMessages(outsider)[0].text).toContain('Already included on retry');
    // The next day's digest must not repeat it: the window closed where the successful retry ended.
    await run(new Date(t0.getTime() + DAY + 600_000));
    expect(digestMessages(outsider)).toHaveLength(1);
  }, 40_000);

  it('does not send an action past the recorded sweep cutoff', async () => {
    // An action committed after the sweep began (its `at` is later than the pass's clock) must stay
    // outside this window; the window ends at the sweep's own time, so including it here would
    // report it twice.
    const s = await setup({ level: 3 });
    expect((await publishNote(s, 'Committed after cutoff')).body.status).toBe('published');
    const t0 = new Date();
    await markAt(s.ws, await latestActionId(s.ws), new Date(t0.getTime() + 1000));
    await primeDigestDue(s.ws, t0);
    await run(t0);
    expect(digestMessages(s.owner)).toHaveLength(0);
  }, 40_000);

  it('does not replay a digest sent by the previous release', async () => {
    const s = await setup({ level: 3 });
    expect((await publishNote(s, 'Included by previous release')).body.status).toBe('published');
    const t0 = new Date(Date.now() + 1000);
    const started = new Date(t0.getTime() - DAY);
    await t.srv.db.admin.query('UPDATE agent_notification_cursor SET last_digest_at = $1 WHERE workspace_id = $2', [t0, s.ws]);
    await legacyDigest(s, started, 'sent', t0);
    await run(new Date(t0.getTime() + 300_000));
    expect(digestMessages(s.owner)).toHaveLength(0);
  }, 40_000);

  it('sends the next digest after an existing ISO-keyed legacy digest', async () => {
    // The previous release wrote the window start into the key and no window metadata. The sent row
    // is the end of that window, not its start; otherwise the next sweep rebuilds the same key and
    // the sponsor never gets another digest.
    const s = await setup({ level: 3 });
    expect((await publishNote(s, 'Activity after the upgrade')).body.status).toBe('published');
    const t0 = new Date(Date.now() - 300_000);
    const started = new Date(t0.getTime() - DAY);
    await t.srv.db.admin.query('UPDATE agent_notification_cursor SET last_digest_at = $1 WHERE workspace_id = $2', [t0, s.ws]);
    await legacyDigest(s, started, 'sent', t0);
    await run(new Date(t0.getTime() + DAY + 300_000));
    expect(digestMessages(s.owner)).toHaveLength(1);
  }, 40_000);

  it('sends the next digest after an existing UTC-day-keyed legacy digest (#1272 re-review)', async () => {
    const s = await setup({ level: 3 });
    expect((await publishNote(s, 'Activity after a day-keyed digest')).body.status).toBe('published');
    const t0 = new Date(Date.now() - 300_000);
    const started = new Date(t0.getTime() - DAY);
    await t.srv.db.admin.query('UPDATE agent_notification_cursor SET last_digest_at = $1 WHERE workspace_id = $2', [t0, s.ws]);
    await legacyDigest(s, started, 'sent', t0, 'day');
    await run(new Date(t0.getTime() + DAY + 300_000));
    expect(digestMessages(s.owner)).toHaveLength(1);
    expect(digestMessages(s.owner)[0].text).toContain('Activity after a day-keyed digest');
  }, 40_000);

  it('retries a failed legacy digest under its original key', async () => {
    // A failed legacy digest has no window metadata either. Its key is the window that must be
    // retried, so the retry reuses that key and records where it ended.
    const s = await setup({ level: 3 });
    expect((await publishNote(s, 'Legacy retry activity')).body.status).toBe('published');
    const t0 = new Date(Date.now() + 1000);
    const started = new Date(t0.getTime() - DAY);
    await t.srv.db.admin.query('UPDATE agent_notification_cursor SET last_digest_at = $1 WHERE workspace_id = $2', [started, s.ws]);
    const key = await legacyDigest(s, started, 'failed', started);
    const retriedAt = new Date(t0.getTime() + 300_000);
    await run(retriedAt);
    const rows = await emailRows(s.ws, 'agent-digest:');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', idempotency_key: key });
    expect(digestMessages(s.owner)).toHaveLength(1);
    const { rows: stored } = await t.srv.db.admin.query<{ start: string; end: string }>(
      `SELECT data->'digestWindow'->>'start' AS start, data->'digestWindow'->>'end' AS end
       FROM messages WHERE workspace_id = $1 AND idempotency_key = $2`,
      [s.ws, key],
    );
    expect(stored[0]).toMatchObject({ start: started.toISOString(), end: retriedAt.toISOString() });
    // The window is closed where the retry ended: the next sweep has nothing to report.
    expect((await run(new Date(retriedAt.getTime() + 300_000))).digests).toBe(0);
  }, 40_000);

  it('reads a hold behind denied drafts in one sweep', async () => {
    // Draft commands can be denied too. They are dropped from the digest and from these e-mails, so
    // they must not fill the sweep's limit before a hold is read (#1272 review).
    const s = await setup({ level: 2 });
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
       SELECT $1, $2, 'artifacts.create', 'draft', 'deny', false, 'rest' FROM generate_series(1, 500)`,
      [s.ws, s.agentId],
    );
    expect((await publishNote(s, 'Hold behind denied drafts')).body.status).toBe('on_hold');
    await run();
    expect(
      outbox.some((m) => m.to === s.owner.email && m.subject.startsWith('Held:') && m.text.includes('Hold behind denied drafts')),
    ).toBe(true);
  }, 40_000);
});

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

describe('the digest window lookup (#1227 review)', () => {
  it('reads each sponsor’s newest digest through the message key index, not the whole history', async () => {
    // A sponsor accumulates one digest row per day. The sweep runs every five minutes, so a
    // DISTINCT ON over every historical row would grow with the workspace's age. The newest row
    // per current sponsor must come from an index range, never a scan of the message log.
    const s = await setup({ level: 3 });
    const prefix = `agent-digest:${s.ws}:${s.owner.id}:`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, purpose, status, created_at, updated_at)
       SELECT $1, 'msg_plan_' || g,
              $2 || to_char(timestamptz '2020-01-01 00:00:00+00' + g * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'onboarding', 'sent', now(), now()
       FROM generate_series(1, 20000) AS g`,
      [s.ws, prefix],
    );
    await t.srv.db.admin.query('ANALYZE messages');

    const plan = await t.srv.db.withWorkspace(s.ws, async (tx) => {
      const res = await tx.execute(sql`EXPLAIN (FORMAT JSON) ${digestWindowsQuery(s.ws)}`);
      const row = res.rows[0]!;
      return (Object.values(row)[0] as [{ Plan: PlanNode }])[0]!.Plan;
    });

    const nodes = planNodes(plan);
    expect(nodes.filter((node) => node['Relation Name'] === 'messages' && node['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(nodes.some((node) => (node['Index Name'] ?? '').includes('idempotency'))).toBe(true);
  }, 60_000);
});
