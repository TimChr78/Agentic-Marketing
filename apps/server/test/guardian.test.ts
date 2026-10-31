import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUARDIAN, runGuardianOnce } from '../src/agents/guardian';
import { startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 19: the guardian caps or pauses an agent by itself when its ledger or guardrails
// look wrong, suspends its holds and tells the sponsor (#253); shadow mode records what a mandate
// would have done while people decide (#256). The guardian is driven directly, like the notifier.

let t: Awaited<ReturnType<typeof startTestServer>>;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const deps = (services = t.srv.services) => ({
  db: t.srv.db,
  services,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

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
  ws: string;
  token: string;
  agentId: string;
  api: ReturnType<typeof t.api>;
}

let unique = 0;

/** A fresh workspace with an agent and a published mandate (content.publish at `level`). */
async function setup(opts: { level?: number; policy?: 'none' | 'agent_changes'; mandate?: Record<string, unknown> } = {}): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-guardian-${n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[owner, 'owner']], opts.policy ?? 'none');
  const api = t.api(owner, ws);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'agents@example.com', useFor: ['transactional'] });
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', { name: 'Watched agent', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
  ).token;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Guarded mandate',
    content: {
      agent: agentId,
      purpose: 'Publish notes for the team',
      validUntil: inDays(30),
      levels: { 'content.publish': opts.level ?? 3 },
      ...opts.mandate,
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { owner, ws, token, agentId, api };
}

async function publishNote(s: Setup, title: string) {
  const created = await agentCall(s.token, 'artifacts.create', { type: 'note', name: title, content: { title, body: 'From the agent.' } });
  expect(created.status).toBe(200);
  return agentCall(s.token, 'artifacts.requestPublish', { artifactId: created.body.artifactId, note: `${title}: the agent’s intent` });
}

/** Ledger rows as if the agent had acted, `minutesAgo` before now. */
async function ledger(
  s: Setup,
  rows: { decision?: string; ok?: boolean; target?: string; actionClass?: string; people?: number; minutesAgo?: number }[],
) {
  for (const r of rows)
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, target, surface, impact, at)
       VALUES ($1, $2, 'artifacts.requestPublish', $3, $4, $5, $6, 'rest', $7, now() - make_interval(mins => $8))`,
      [
        s.ws,
        s.agentId,
        r.actionClass ?? 'content.publish',
        r.decision ?? 'allow',
        r.ok ?? true,
        r.target ?? null,
        JSON.stringify(r.people === undefined ? {} : { people: r.people }),
        r.minutesAgo ?? 1,
      ],
    );
}

const guardianMail = async (ws: string) =>
  (
    await t.srv.db.admin.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE 'guardian:%'`,
      [ws],
    )
  ).rows;

beforeAll(async () => {
  t = await startTestServer('test_guardian', testPort(3487));
}, 90_000);
afterAll(() => t?.close());
beforeEach(() => {
  outbox.length = 0;
});

describe('the guardian (#253)', () => {
  it('pauses an agent that changes the same artifact again and again, and tells the sponsor', async () => {
    const s = await setup();
    await ledger(
      s,
      Array.from({ length: GUARDIAN.loopPerHour }, () => ({ target: 'not_loop' })),
    );
    expect((await runGuardianOnce(deps())).episodes).toBeGreaterThanOrEqual(1);

    const agent = await s.api.call('agents.get', { id: s.agentId });
    expect(agent).toMatchObject({ status: 'paused', guard: { cap: 1 } });
    expect(agent.statusReason).toContain('in a loop');
    const { episodes } = await s.api.call('agents.guardian', { agentId: s.agentId });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'loop', action: 'pause', evidence: { target: 'not_loop', changes: GUARDIAN.loopPerHour } });
    expect(await guardianMail(s.ws)).toHaveLength(1);
    expect((await agentCall(s.token, 'agents.get')).status).toBe(403);

    // An open episode is not repeated on the next round.
    expect((await runGuardianOnce(deps())).episodes).toBe(0);
  });

  it('a resumed agent stays capped until a person clears the guardian', async () => {
    const s = await setup();
    await ledger(
      s,
      Array.from({ length: GUARDIAN.probingPerHour }, () => ({ decision: 'deny' })),
    );
    await runGuardianOnce(deps());
    expect((await s.api.call('agents.guardian', { agentId: s.agentId, open: true })).episodes[0]).toMatchObject({
      kind: 'probing',
      action: 'pause',
    });

    await s.api.call('agents.resume', { id: s.agentId });
    const capped = await publishNote(s, 'While capped');
    expect(capped.body.status).toBe('in_review');
    const { actions } = await s.api.call('agents.activity', { agentId: s.agentId, limit: 1 });
    expect(actions[0].reasons.join(' ')).toContain('probing');

    // Agents cannot clear it themselves.
    expect((await agentCall(s.token, 'agents.clearGuard', { agentId: s.agentId, note: 'me' })).status).toBe(403);
    const cleared = await s.api.call('agents.clearGuard', { agentId: s.agentId, note: 'A test script, not the agent.' });
    expect(cleared).toMatchObject({ cleared: 1, agent: { guard: null } });
    expect((await publishNote(s, 'After clearing')).body.status).toBe('published');
    // The refusals before the clearing do not count again.
    expect((await runGuardianOnce(deps())).episodes).toBe(0);
  });

  it('caps an agent whose sends breach its guardrails', async () => {
    const s = await setup();
    const services = { ...t.srv.services, mandateGuardrails: async () => 'Unsubscribe rate 3%, above its mandate’s guardrail of 1%.' };
    await runGuardianOnce(deps(services));
    const { guard, episodes } = await s.api.call('agents.guardian', { agentId: s.agentId });
    expect(guard).toMatchObject({ cap: 1 });
    expect(episodes.find((e) => e.kind === 'guardrail')).toMatchObject({
      action: 'cap',
      reason: expect.stringContaining('Unsubscribe rate 3%'),
    });
    expect((await s.api.call('agents.get', { id: s.agentId })).status).toBe('active');
    expect((await publishNote(s, 'Capped')).body.status).toBe('in_review');
    await s.api.call('agents.clearGuard', { agentId: s.agentId, note: 'checked' });
  });

  it('a send far larger than usual holds irreversible actions and suspends pending holds', async () => {
    const s = await setup({ level: 2 });
    const held = await publishNote(s, 'Held note');
    expect(held.body.status).toBe('on_hold');
    await ledger(s, [
      { actionClass: 'send.broadcast', people: 100, minutesAgo: 600 },
      { actionClass: 'send.broadcast', people: 120, minutesAgo: 500 },
      { actionClass: 'send.broadcast', people: 90, minutesAgo: 400 },
      { actionClass: 'send.broadcast', people: 1000, minutesAgo: 5, target: 'bct_big' },
    ]);
    await runGuardianOnce(deps());
    const { guard, episodes } = await s.api.call('agents.guardian', { agentId: s.agentId });
    expect(guard).toMatchObject({ cap: 4, irreversibleCap: 2 });
    const e = episodes.find((x) => x.kind === 'anomaly');
    expect(e).toMatchObject({ action: 'hold', suspendedHolds: 1, evidence: { people: 1000, median: 100 } });
    const { rows } = await t.srv.db.admin.query<{ hold_until: Date | null; note: string; status: string }>(
      `SELECT hold_until, note, status FROM approval_requests WHERE workspace_id = $1 AND requested_by_type = 'agent'`,
      [s.ws],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hold_until: null, status: 'pending' });
    expect(rows[0].note).toContain('The guardian suspended this hold');
    expect((await s.api.call('agents.get', { id: s.agentId })).status).toBe('active');
  });

  it('caps an agent whose actions keep failing', async () => {
    const s = await setup();
    await ledger(
      s,
      Array.from({ length: GUARDIAN.errorsPerHour }, () => ({ ok: false })),
    );
    await runGuardianOnce(deps());
    expect((await s.api.call('agents.guardian', { agentId: s.agentId })).episodes[0]).toMatchObject({ kind: 'errors', action: 'cap' });
  });

  it('leaves agents without a mandate and quiet agents alone', async () => {
    const s = await setup();
    await ledger(s, [{ target: 'a' }, { target: 'b' }, { decision: 'deny' }]);
    await runGuardianOnce(deps());
    expect((await s.api.call('agents.guardian', { agentId: s.agentId })).episodes).toHaveLength(0);
  });
});

describe('shadow mode (#256)', () => {
  it('records what the mandate would do while a person decides, and reports how they compare', async () => {
    // The ceiling stays at a person; in shadow the mandate may ask for level 3 anyway.
    const s = await setup({ policy: 'agent_changes', mandate: { shadow: true } });
    await s.api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 1 } });

    const first = await publishNote(s, 'Shadow one');
    expect(first.body.status).toBe('in_review');
    const second = await publishNote(s, 'Shadow two');
    const { actions } = await s.api.call('agents.activity', { agentId: s.agentId, limit: 2 });
    // The engine leaves it to the approval policy (agent_changes: a person reviews it).
    expect(actions[0]).toMatchObject({ decision: 'allow', shadow: { decision: 'allow', level: 3 } });
    expect(second.body.status).toBe('in_review');
    expect(actions[0].mandateId).toBeTruthy();

    await s.api.call('approvals.approve', { approvalId: first.body.approvalId });
    await s.api.call('approvals.reject', { approvalId: second.body.approvalId, note: 'Not this one' });
    await publishNote(s, 'Shadow three');

    const report = await s.api.call('agents.shadowReport', { agentId: s.agentId });
    expect(report.summary).toMatchObject({ total: 3, agree: 1, tooBold: 1, pending: 1, agreementRate: 0.5 });
    expect(report.byClass['content.publish']).toMatchObject({ total: 3, agree: 1, tooBold: 1 });
  });
});
