import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHostedAgentsOnce } from '../src/agents/hosted';
import { HOSTED_AGENT_TEMPLATES, hostedAgentTemplate } from '../src/agents/hostedTemplates';
import { startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 19 (#258, #86): the platform runs a hosted agent itself on a schedule. Each run is
// a fresh copilot session on the in-process MCP client, as the agent principal, with budgets and a
// run history; the sponsor gets the summary by e-mail. The scheduler is driven directly with a
// clock, like the alert and notification tests.

const PORT = testPort(3491);
const DAY = 86_400_000;
/** Beyond every schedule (a weekly run is at most seven days away). */
const DUE = () => new Date(Date.now() + 8 * DAY);

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let llm: Awaited<ReturnType<typeof fakeLlm>>;

/** What the fake model does, chosen per test by a marker in the agent's instructions. */
let blockReached: (() => void) | undefined;
let blockRelease: (() => void) | undefined;
let blockReachedPromise: Promise<void> = Promise.resolve();
let blockReleasePromise: Promise<void> = Promise.resolve();

function answer(r: FakeRequest) {
  if (r.user.includes('[fail]')) return { status: 500, error: 'the model is unavailable' };
  if (r.user.includes('[overlap]')) {
    blockReached?.();
    return blockReleasePromise.then(() => ({ text: 'Overlapping run finished.' }));
  }
  if (r.user.includes('[budget]')) return { toolCalls: [{ name: 'agents__get', input: {} }] };
  if (r.user.includes('[scope]')) {
    if (r.toolResults.length === 0)
      return {
        toolCalls: [{ name: 'artifacts__create', input: { type: 'note', name: 'Not allowed', content: { title: 'No', body: 'No.' } } }],
      };
    return { text: 'The write was refused, as expected.' };
  }
  if (r.toolResults.length === 0) return { toolCalls: [{ name: 'agents__get', input: {} }] };
  return { text: 'Last week: 1 broadcast, 2 live journeys, all within the limits.' };
}

const deps = () => ({
  db: t.srv.db,
  executor: t.srv.executor,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

const runAt = (now: Date) => runHostedAgentsOnce(deps(), now);

/** Keep the other tests' hosted agents out of this sweep, and make this one due. */
const onlyDue = (agentId: string) =>
  t.srv.db.admin.query(
    `UPDATE hosted_agents SET next_run_at = CASE WHEN agent_id = $1 THEN now() - interval '1 minute' ELSE 'infinity' END`,
    [agentId],
  );

interface Setup {
  owner: User;
  ws: string;
  api: ReturnType<Server['api']>;
  agentId: string;
}

let unique = 0;

async function setup(
  instructions: string,
  opts: {
    schedule?: string;
    scopes?: ('artifacts:read' | 'audit:read' | 'artifacts:write')[];
    maxTokensPerRun?: number;
    maxToolCallsPerRun?: number;
    name?: string;
  } = {},
): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-hosted-${n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'agents@example.com',
    useFor: ['transactional'],
  });
  await api.call('aiProviders.create', {
    name: 'Model',
    kind: 'anthropic-compatible',
    baseUrl: llm.baseUrl,
    models: { default: 'claude-sonnet-test' },
    apiKey: 'sk-test-0123456789',
    useFor: ['copilot'],
  });
  const hosted = await api.call('agents.createHosted', {
    name: opts.name ?? `Hosted ${n}`,
    instructions,
    schedule: opts.schedule ?? 'daily:07:00',
    scopes: opts.scopes ?? ['artifacts:read', 'audit:read'],
    maxTokensPerRun: opts.maxTokensPerRun ?? 20_000,
    maxToolCallsPerRun: opts.maxToolCallsPerRun ?? 10,
  });
  return { owner, ws, api, agentId: hosted.agentId };
}

let weekly: Setup;
let scope: Setup;
let budget: Setup;
let failing: Setup;
let overlapping: Setup;

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_hosted_agents', PORT);
  weekly = await setup(`[weekly] ${hostedAgentTemplate('weekly_report')!.instructions}`, {
    name: 'Weekly report',
    schedule: 'weekly:mon:07:00',
    maxTokensPerRun: 30_000,
    maxToolCallsPerRun: 25,
  });
  scope = await setup('[scope] Try a write outside the granted scopes.', { scopes: ['artifacts:read'] });
  budget = await setup('[budget] Keep reading until the budget stops you.', { maxTokensPerRun: 100, maxToolCallsPerRun: 5 });
  failing = await setup('[fail] This run always fails.');
  overlapping = await setup('[overlap] A slow run.');
}, 120_000);

beforeEach(() => {
  outbox.length = 0;
});

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('hosted agents (#258)', () => {
  it('creates the weekly-report template with its schedule, scopes and budgets, and runs it when due', async () => {
    await onlyDue(weekly.agentId);
    const template = hostedAgentTemplate('weekly_report')!;
    expect(HOSTED_AGENT_TEMPLATES.map((x) => x.key)).toEqual(['weekly_report', 'deliverability_guardian']);
    const view = await weekly.api.call('agents.hostedRuns', { agentId: weekly.agentId });
    expect(view.hosted).toMatchObject({
      name: 'Weekly report',
      schedule: 'weekly:mon:07:00',
      scheduleText: 'Every Monday at 07:00',
      timeZone: 'UTC',
      scopes: template.scopes,
      enabled: true,
      budgets: { maxTokensPerRun: template.maxTokensPerRun, maxToolCallsPerRun: 25 },
      consecutiveFailures: 0,
    });
    expect(view.hosted?.nextRunAt).toBeTruthy();

    // The run is due; the fake model reads agents.get through the in-process MCP client, then answers.
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary).toMatchObject({ due: 1, ok: 1, failed: 0, skipped: 0 });
    expect(llm.requests.length - before).toBe(2);
    expect(llm.requests.at(-2)?.tools).toContain('agents__get');
    expect(llm.requests.at(-1)?.toolResults[0]).toContain('Weekly report');

    const runs = await weekly.api.call('agents.hostedRuns', { agentId: weekly.agentId });
    expect(runs.runs[0]).toMatchObject({
      status: 'ok',
      toolCalls: 1,
      error: null,
    });
    expect(runs.runs[0]!.tokens).toBeGreaterThan(0);
    expect(runs.runs[0]!.summary).toContain('Last week');
    expect(runs.hosted?.consecutiveFailures).toBe(0);
    expect(runs.hosted?.lastRunAt).toBeTruthy();

    // The sponsor gets the summary by e-mail, once.
    const mails = outbox.filter((m) => m.to === weekly.owner.email && m.subject.startsWith('Hosted agent report'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Last week');
  }, 60_000);

  it('refuses a tool call outside its scopes and still finishes the run', async () => {
    await onlyDue(scope.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    expect(llm.requests.length - before).toBe(2);
    // The executor refused the write: the model saw a 403, and no note was created.
    expect(llm.requests.at(-1)?.toolResults[0]).toContain('This agent was not granted the');
    expect(llm.requests.at(-1)?.toolResults[0]).toContain('artifacts:write');
    const artifacts = await scope.api.call('artifacts.list', {});
    expect(artifacts.artifacts.filter((a) => a.name === 'Not allowed')).toHaveLength(0);
    const runs = await scope.api.call('agents.hostedRuns', { agentId: scope.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'ok', toolCalls: 1, error: null });
  }, 60_000);

  it('stops at the token budget', async () => {
    await onlyDue(budget.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    // One model step used more than the 100-token budget, so the loop stopped there.
    expect(llm.requests.length - before).toBe(1);
    const runs = await budget.api.call('agents.hostedRuns', { agentId: budget.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'ok', toolCalls: 1 });
    expect(runs.runs[0]!.tokens).toBeGreaterThanOrEqual(100);
    expect(runs.runs[0]!.summary).toContain('budget');
  }, 60_000);

  it('disables the agent after three consecutive failures and tells the sponsor', async () => {
    await onlyDue(failing.agentId);
    for (let i = 1; i <= 3; i++) {
      await failing.api.call('agents.runHostedNow', { agentId: failing.agentId });
      const summary = await runAt(new Date(Date.now() + 1000));
      expect(summary.failed).toBe(1);
      const view = await failing.api.call('agents.hostedRuns', { agentId: failing.agentId });
      expect(view.hosted?.consecutiveFailures).toBe(i);
      expect(view.hosted?.enabled).toBe(i < 3);
    }
    const view = await failing.api.call('agents.hostedRuns', { agentId: failing.agentId });
    expect(view.runs).toHaveLength(3);
    expect(view.runs.every((r) => r.status === 'failed')).toBe(true);
    expect(view.runs[0]!.error).toBeTruthy();
    expect(view.hosted).toMatchObject({ enabled: false, nextRunAt: null });
    const disabledMail = outbox.find((m) => m.to === failing.owner.email && m.subject.startsWith('Hosted agent disabled'));
    expect(disabledMail).toBeTruthy();
    expect(disabledMail!.text).toContain('disabled');
    // A disabled agent cannot be run.
    await expect(failing.api.call('agents.runHostedNow', { agentId: failing.agentId })).rejects.toMatchObject({
      message: expect.stringContaining('disabled'),
    });
  }, 90_000);

  it('never runs two instances of the same agent at once', async () => {
    blockReachedPromise = new Promise<void>((resolve) => {
      blockReached = resolve;
    });
    blockReleasePromise = new Promise<void>((resolve) => {
      blockRelease = resolve;
    });
    await onlyDue(overlapping.agentId);
    const before = llm.requests.length;
    const first = runAt(DUE());
    await blockReachedPromise;
    // While the first is in the model call, make the agent due again and sweep once more.
    await t.srv.db.admin.query('UPDATE hosted_agents SET next_run_at = now() WHERE workspace_id = $1 AND agent_id = $2', [
      overlapping.ws,
      overlapping.agentId,
    ]);
    const second = await runAt(DUE());
    expect(second.skipped).toBe(1);
    blockRelease?.();
    await first;

    const view = await overlapping.api.call('agents.hostedRuns', { agentId: overlapping.agentId });
    expect(view.runs.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(view.runs.filter((r) => r.status === 'skipped')).toHaveLength(1);
    expect(llm.requests.length - before).toBe(1);
  }, 60_000);

  it('refuses a malformed schedule and a scope above the caller’s role', async () => {
    const owner = await t.signUp(`owner-hosted-bad-${Date.now()}@example.com`);
    const ownerWs = await t.workspaceWith([[owner, 'owner']], 'none');
    await expect(
      t.api(owner, ownerWs).call('agents.createHosted', {
        name: 'Bad schedule',
        instructions: 'x',
        schedule: 'daily:7:00',
        scopes: ['artifacts:read'],
      } as never),
    ).rejects.toMatchObject({ status: 400 });

    const viewer = await t.signUp(`viewer-hosted-${Date.now()}@example.com`);
    const viewerWs = await t.workspaceWith([[viewer, 'viewer']], 'none');
    await expect(
      t.api(viewer, viewerWs).call('agents.createHosted', {
        name: 'Too much',
        instructions: 'x',
        schedule: 'hourly',
        scopes: ['artifacts:write'],
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  }, 30_000);
});
