import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { agentPrincipal } from '@agentic-marketing/commands';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHostedAgentsOnce } from '../src/agents/hosted';
import { HOSTED_AGENT_TEMPLATES, hostedAgentTemplate } from '../src/agents/hostedTemplates';
import { commands } from '../src/registry';
import { rejects, startTestServer, testPort, type User } from './harness';

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
  if (r.messages.some((m) => m.text.includes('[stepfail]'))) {
    if (r.toolResults.length === 0) return { toolCalls: [{ name: 'agents__get', input: {} }] };
    return { status: 500, error: 'the model failed after the first step' };
  }
  if (r.user.includes('[fail]')) return { status: 500, error: 'the model is unavailable' };
  if (r.user.includes('[overlap]')) {
    blockReached?.();
    return blockReleasePromise.then(() => ({ text: 'Overlapping run finished.' }));
  }
  if (r.messages.some((m) => m.text.includes('[budget]'))) return { toolCalls: [{ name: 'agents__get', input: {} }] };
  if (r.user.includes('[scope]')) return { text: 'Only the tools my scopes grant were offered.' };
  if (r.toolResults.length === 0) return { toolCalls: [{ name: 'agents__get', input: {} }] };
  return { text: 'Last week: 1 broadcast, 2 live journeys, all within the limits.' };
}

/** Tokens the fake model reports for one step: 100 in, 20 out. */
const STEP_INPUT = 100;
const STEP_OUTPUT = 20;
const STEP_TOKENS = STEP_INPUT + STEP_OUTPUT;

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
    monthlyTokenBudget?: number | null;
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
    monthlyTokenBudget: opts.monthlyTokenBudget ?? null,
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
let shrinking: Setup;
let tooBigBudget: Setup;
let failing: Setup;
let stepFailed: Setup;
let billingHeld: Setup;
let billingFallback: Setup;
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
  // Two steps of 120 tokens fit and a third does not: the second step's output is capped at the
  // 130 tokens left, and after it only 10 remain.
  shrinking = await setup('[budget] Keep reading until the budget stops you.', { maxTokensPerRun: 250, maxToolCallsPerRun: 5 });
  // The full run allowance is 200k, the month only has 100k left: the run must not start.
  tooBigBudget = await setup('[too-big] This run cannot be covered by the budget.', {
    maxTokensPerRun: 200_000,
    monthlyTokenBudget: 100_000,
  });
  failing = await setup('[fail] This run always fails.');
  stepFailed = await setup('[stepfail] This run fails after its first step.', { maxTokensPerRun: 20_000 });
  // The whole monthly allowance is the run's reservation, so a retained hold really does make the
  // rest of the month unavailable.
  billingHeld = await setup('[billing-hold] A run whose usage cannot be recorded.', {
    maxTokensPerRun: 1000,
    monthlyTokenBudget: 1000,
  });
  billingFallback = await setup('[billing-fallback] A run whose first usage write fails.', {
    maxTokensPerRun: 1000,
    monthlyTokenBudget: 1000,
  });
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
    expect(HOSTED_AGENT_TEMPLATES.map((x) => x.key)).toEqual([
      'weekly_report',
      'deliverability_guardian',
      'lifecycle_optimiser',
      'newsletter_editor',
      'experimentation_agent',
      'audience_curator',
    ]);
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
    const usageBefore = (await weekly.api.call('aiProviders.list', {})).providers[0]!.usedThisMonth;
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

    // The run is one recorded AI call, and the tokens are the provider's usage for the month.
    const usage = (await weekly.api.call('aiProviders.list', {})).providers[0]!.usedThisMonth;
    expect(usage).toBeGreaterThan(usageBefore);
    expect(usage).toBe(runs.runs[0]!.tokens);
    const calls = await weekly.api.call('ai.calls', { kind: 'hosted' });
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]).toMatchObject({ kind: 'hosted', status: 'done', model: 'claude-sonnet-test' });
    expect(calls.calls[0]!.inputTokens + calls.calls[0]!.outputTokens).toBe(runs.runs[0]!.tokens);

    // The sponsor gets the summary by e-mail, once.
    const mails = outbox.filter((m) => m.to === weekly.owner.email && m.subject.startsWith('Hosted agent report'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Last week');
  }, 60_000);

  it('offers no tool outside its scopes, and the executor still refuses a direct call', async () => {
    await onlyDue(scope.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    // One model step: the run was offered read tools only, never the write it could not use, so
    // there was nothing to call and nothing to retry (#364).
    expect(llm.requests.length - before).toBe(1);
    const offered = llm.requests.at(-1)?.tools ?? [];
    expect(offered).toContain('agents__get');
    expect(offered).not.toContain('artifacts__create');
    expect(offered).not.toContain('artifacts__requestPublish');
    const artifacts = await scope.api.call('artifacts.list', {});
    expect(artifacts.artifacts.filter((a) => a.name === 'Not allowed')).toHaveLength(0);
    const runs = await scope.api.call('agents.hostedRuns', { agentId: scope.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'ok', toolCalls: 0, error: null });
    expect(runs.runs[0]!.summary).toContain('scopes');

    // The catalogue is a filter, not the enforcement point: a direct call outside the scopes is
    // still refused by the executor with the same mandate.
    const create = commands.find((c) => c.name === 'artifacts.create')!;
    const principal = agentPrincipal(scope.owner.id, 'hosted-test-client', scope.ws, 'viewer', ['artifacts:read']);
    const err = await rejects(
      t.srv.executor.execute(create, { type: 'note', name: 'Not allowed', content: { title: 'No', body: 'No.' } }, principal, {
        surface: 'mcp',
      }),
    );
    expect(err.message).toContain('not granted');
    expect(err.message).toContain('artifacts:write');
  }, 60_000);

  it('stops at the token budget', async () => {
    await onlyDue(budget.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    // The one step is capped at the 100-token budget (no 200-token floor above it), and after it
    // the run has nothing left, so the loop stopped there.
    expect(llm.requests.length - before).toBe(1);
    expect(llm.requests.at(-1)?.maxOutputTokens).toBe(100);
    const runs = await budget.api.call('agents.hostedRuns', { agentId: budget.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'ok', toolCalls: 1 });
    // A step's input cannot be capped, only its output: the run overshoots the budget by at most
    // the input tokens of its last step.
    expect(runs.runs[0]!.tokens).toBeGreaterThan(100);
    expect(runs.runs[0]!.tokens).toBeLessThanOrEqual(100 + STEP_INPUT);
    expect(runs.runs[0]!.summary).toContain('budget');
  }, 60_000);

  it('caps each step at the tokens still left, and starts no step that cannot fit', async () => {
    await onlyDue(shrinking.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    // Two steps of 120 tokens each: the first gets the 250-token allowance, the second the 130
    // still left. After them only 10 tokens remain, below the floor for another step.
    expect(llm.requests.length - before).toBe(2);
    expect(llm.requests.slice(before).map((r) => r.maxOutputTokens)).toEqual([250, 250 - STEP_TOKENS]);
    const runs = await shrinking.api.call('agents.hostedRuns', { agentId: shrinking.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'ok', toolCalls: 2, tokens: 2 * STEP_TOKENS });
    expect(runs.runs[0]!.tokens).toBeLessThanOrEqual(250 + STEP_INPUT);
  }, 60_000);

  it('records the tokens of the steps that ran when a later step fails', async () => {
    await onlyDue(stepFailed.agentId);
    const summary = await runAt(DUE());
    expect(summary).toMatchObject({ due: 1, ok: 0, failed: 1 });
    const runs = await stepFailed.api.call('agents.hostedRuns', { agentId: stepFailed.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'failed', tokens: STEP_TOKENS });
    // The usage of the step that did run is in ai_calls and in the month's usage, not lost.
    const calls = await stepFailed.api.call('ai.calls', { kind: 'hosted' });
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]).toMatchObject({ status: 'failed', inputTokens: STEP_INPUT, outputTokens: STEP_OUTPUT });
    const providers = await stepFailed.api.call('aiProviders.list', {});
    expect(providers.providers[0]!.usedThisMonth).toBe(STEP_TOKENS);
  }, 60_000);

  // #420: the old finally block swallowed a failed ai_calls insert and then released the hold, so
  // a billed run was counted nowhere and the month could spend the same allowance again.
  it('keeps billed usage covered when the usage write fails, instead of releasing the hold', async () => {
    const providerId = (await billingHeld.api.call('aiProviders.list', {})).providers[0]!.id;
    await t.srv.db.admin.query(`CREATE OR REPLACE FUNCTION hosted_ai_call_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.input->>'hostedAgentId' = '${billingHeld.agentId}' THEN RAISE EXCEPTION 'injected ai_calls failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await t.srv.db.admin.query('DROP TRIGGER IF EXISTS hosted_ai_call_fail_trg ON ai_calls');
    await t.srv.db.admin.query(
      'CREATE TRIGGER hosted_ai_call_fail_trg BEFORE INSERT ON ai_calls FOR EACH ROW EXECUTE FUNCTION hosted_ai_call_fail_fn()',
    );
    try {
      await onlyDue(billingHeld.agentId);
      const summary = await runAt(DUE());
      expect(summary).toMatchObject({ due: 1, ok: 1 });

      // The provider was billed, but neither the settling insert nor its fallback could land.
      const calls = await billingHeld.api.call('ai.calls', { kind: 'hosted' });
      expect(calls.calls).toHaveLength(0);
      const providers = await billingHeld.api.call('aiProviders.list', {});
      expect(providers.providers[0]!.usedThisMonth).toBe(1000);
      const held = await t.srv.db.admin.query<{ tokens: number; expires_at: Date }>(
        'SELECT tokens, expires_at FROM ai_token_reservations WHERE provider_id = $1',
        [providerId],
      );
      expect(held.rows).toHaveLength(1);
      expect(held.rows[0]!.tokens).toBe(1000);
      // Not the old five-minute default: the only record of billed usage survives the month.
      const now = new Date();
      expect(held.rows[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime(),
      );

      // The allowance is genuinely unavailable: the next due run is refused before the model.
      await onlyDue(billingHeld.agentId);
      const requestsBefore = llm.requests.length;
      const retry = await runAt(new Date(DUE().getTime() + 1000));
      expect(retry).toMatchObject({ due: 1, failed: 1 });
      expect(llm.requests.length).toBe(requestsBefore);
      const runs = await billingHeld.api.call('agents.hostedRuns', { agentId: billingHeld.agentId });
      expect(runs.runs[0]!.error).toContain('budget');
    } finally {
      await t.srv.db.admin.query('DROP TRIGGER IF EXISTS hosted_ai_call_fail_trg ON ai_calls');
      await t.srv.db.admin.query('DROP FUNCTION IF EXISTS hosted_ai_call_fail_fn()');
    }
  }, 90_000);

  it('retries usage once through the fallback and releases the hold after the first write fails', async () => {
    const providerId = (await billingFallback.api.call('aiProviders.list', {})).providers[0]!.id;
    await t.srv.db.admin.query('DROP SEQUENCE IF EXISTS hosted_ai_call_fail_once');
    await t.srv.db.admin.query('CREATE SEQUENCE hosted_ai_call_fail_once START 1');
    await t.srv.db.admin.query(`CREATE OR REPLACE FUNCTION hosted_ai_call_fail_once_fn() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF NEW.input->>'hostedAgentId' = '${billingFallback.agentId}' AND nextval('hosted_ai_call_fail_once') = 1
          THEN RAISE EXCEPTION 'injected ai_calls failure';
        END IF;
        RETURN NEW;
      END $$`);
    await t.srv.db.admin.query('DROP TRIGGER IF EXISTS hosted_ai_call_fail_once_trg ON ai_calls');
    await t.srv.db.admin.query(
      'CREATE TRIGGER hosted_ai_call_fail_once_trg BEFORE INSERT ON ai_calls FOR EACH ROW EXECUTE FUNCTION hosted_ai_call_fail_once_fn()',
    );
    try {
      await onlyDue(billingFallback.agentId);
      const summary = await runAt(DUE());
      expect(summary).toMatchObject({ due: 1, ok: 1 });

      // The fallback writes the same call id, so the retried usage is one row and one charge.
      const calls = await billingFallback.api.call('ai.calls', { kind: 'hosted' });
      expect(calls.calls).toHaveLength(1);
      expect(calls.calls[0]).toMatchObject({
        status: 'done',
        inputTokens: 2 * STEP_INPUT,
        outputTokens: 2 * STEP_OUTPUT,
      });
      const providers = await billingFallback.api.call('aiProviders.list', {});
      expect(providers.providers[0]!.usedThisMonth).toBe(2 * STEP_TOKENS);
      const held = await t.srv.db.admin.query('SELECT tokens FROM ai_token_reservations WHERE provider_id = $1', [providerId]);
      expect(held.rows).toHaveLength(0);
    } finally {
      await t.srv.db.admin.query('DROP TRIGGER IF EXISTS hosted_ai_call_fail_once_trg ON ai_calls');
      await t.srv.db.admin.query('DROP FUNCTION IF EXISTS hosted_ai_call_fail_once_fn()');
      await t.srv.db.admin.query('DROP SEQUENCE IF EXISTS hosted_ai_call_fail_once');
    }
  }, 90_000);

  it('refuses a run whose full token allowance does not fit the monthly budget, before calling the model', async () => {
    await onlyDue(tooBigBudget.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary).toMatchObject({ due: 1, ok: 0, failed: 1, skipped: 0 });
    // The model was never called: the run allowance (200k) cannot be reserved from a 100k budget.
    expect(llm.requests.length).toBe(before);
    const runs = await tooBigBudget.api.call('agents.hostedRuns', { agentId: tooBigBudget.agentId });
    expect(runs.runs[0]).toMatchObject({ status: 'failed', toolCalls: 0, tokens: 0 });
    expect(runs.runs[0]!.error).toContain('budget');
    const providers = await tooBigBudget.api.call('aiProviders.list', {});
    expect(providers.providers[0]!.usedThisMonth).toBe(0);
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

describe('event-triggered hosted runs (#338)', () => {
  /** An agent event on the hosted agent's trigger subscription, as the events sweep records it. */
  async function event(s: Setup, summary: string, at = new Date()) {
    const { rows } = await t.srv.db.admin.query<{ trigger_subscription_id: string }>(
      'SELECT trigger_subscription_id FROM hosted_agents WHERE agent_id = $1',
      [s.agentId],
    );
    await t.srv.db.admin.query(
      `INSERT INTO agent_events (workspace_id, agent_id, subscription_id, type, event_key, summary, subject, at)
       VALUES ($1, $2, $3, 'guardrail.breach', $4, $5, '{"episodeId":"gde_x"}', $6)`,
      [s.ws, s.agentId, rows[0].trigger_subscription_id, `k-${Math.random()}`, summary, at],
    );
  }
  const runs = async (s: Setup) => (await s.api.call('agents.hostedRuns', { agentId: s.agentId })).runs;

  it('runs when a subscribed event arrives, with the event in its prompt, within the gap and daily cap', async () => {
    const s = await setup('Check deliverability now.', { name: 'Event guardian' });
    // Out of the scheduled sweep; only events start it.
    await t.srv.db.admin.query(`UPDATE hosted_agents SET next_run_at = '2999-01-01'`);
    const view = await s.api.call('agents.updateHosted', {
      agentId: s.agentId,
      triggers: ['guardrail.breach'],
      eventMinGapMinutes: 30,
      eventRunsPerDay: 2,
    });
    expect(view).toMatchObject({ triggers: ['guardrail.breach'], eventMinGapMinutes: 30, eventRunsPerDay: 2 });
    const eventOnlyAt = async (now: Date) => {
      // An event claim recalculates next_run_at; exclude scheduled wakes at every simulated tick.
      await t.srv.db.admin.query(`UPDATE hosted_agents SET next_run_at = '2999-01-01' WHERE agent_id = $1`, [s.agentId]);
      return runAt(now);
    };

    // No event yet: nothing runs.
    await eventOnlyAt(new Date());
    expect(await runs(s)).toHaveLength(0);

    await event(s, 'Unsubscribe rate 3%, above the mandate guardrail of 1%.');
    const before = llm.requests.length;
    await eventOnlyAt(new Date());
    const first = await runs(s);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'ok', trigger: 'event' });
    expect(first[0].eventIds).toHaveLength(1);
    expect(llm.requests.slice(before).some((r) => r.user.includes('guardrail.breach') && r.user.includes('Unsubscribe rate 3%'))).toBe(
      true,
    );

    // A second event inside the 30-minute gap waits; after the gap it runs.
    await event(s, 'Complaint rate 0.4%.');
    await eventOnlyAt(new Date());
    expect(await runs(s)).toHaveLength(1);
    await eventOnlyAt(new Date(Date.now() + 31 * 60_000));
    expect(await runs(s)).toHaveLength(2);

    // The daily cap of 2 event runs holds back a third.
    await event(s, 'Bounce rate 6%.');
    await eventOnlyAt(new Date(Date.now() + 70 * 60_000));
    expect(await runs(s)).toHaveLength(2);

    // Without triggers the subscription is removed and events stop runs.
    await s.api.call('agents.updateHosted', { agentId: s.agentId, triggers: [] });
    const { rows } = await t.srv.db.admin.query('SELECT trigger_subscription_id FROM hosted_agents WHERE agent_id = $1', [s.agentId]);
    expect(rows[0].trigger_subscription_id).toBeNull();
  });

  it('a failed event run keeps its events for a retry; a paused agent runs none and skips stale events on resume (#342, #344)', async () => {
    const s = await setup('Check now. [fail]', { name: 'Flaky guardian' });
    await t.srv.db.admin.query(`UPDATE hosted_agents SET next_run_at = '2999-01-01'`);
    await s.api.call('agents.updateHosted', {
      agentId: s.agentId,
      triggers: ['guardrail.breach'],
      eventMinGapMinutes: 30,
      eventRunsPerDay: 5,
    });
    await event(s, 'Unsubscribe rate 3%.');
    await runAt(new Date());
    const failed = await runs(s);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed', trigger: 'event' });
    // The event was not consumed: after the gap it is retried with the same event.
    await runAt(new Date(Date.now() + 31 * 60_000));
    const retried = await runs(s);
    expect(retried).toHaveLength(2);
    expect(retried[0].eventIds).toEqual(failed[0].eventIds);
    // Inside the gap, nothing is selected and no skipped run is written (#343).
    await runAt(new Date(Date.now() + 40 * 60_000));
    expect(await runs(s)).toHaveLength(2);

    // Paused: no run and no skipped row per tick, however many sweeps (#344).
    const p = await setup('Check now.', { name: 'Paused guardian' });
    await t.srv.db.admin.query(`UPDATE hosted_agents SET next_run_at = '2999-01-01'`);
    await p.api.call('agents.updateHosted', { agentId: p.agentId, triggers: ['guardrail.breach'] });
    await p.api.call('agents.pause', { id: p.agentId, reason: 'Holiday' });
    await event(p, 'Complaint rate 0.4%.', new Date(Date.now() - 2 * 86_400_000));
    await runAt(new Date());
    await runAt(new Date());
    expect(await runs(p)).toHaveLength(0);
    // Resumed: the two-day-old event is marked read without a run.
    await p.api.call('agents.resume', { id: p.agentId });
    await runAt(new Date());
    expect(await runs(p)).toHaveLength(0);
    const { rows } = await t.srv.db.admin.query<{ last_event_id: string }>('SELECT last_event_id FROM hosted_agents WHERE agent_id = $1', [
      p.agentId,
    ]);
    expect(Number(rows[0].last_event_id)).toBeGreaterThan(0);
  });

  it('templates that react to events say which (#338)', () => {
    expect(hostedAgentTemplate('deliverability_guardian')!.triggers).toEqual(['guardrail.breach', 'alert.fired']);
    expect(hostedAgentTemplate('weekly_report')!.triggers).toEqual([]);
  });
});
