import { type FakeReply, type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { outbox } from '@agentic-marketing/email';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runScoped } from '../../../packages/db/test/run';
import { seededRandom } from '../../../test-support/index';
import { runHostedAgentsOnce } from '../src/agents/hosted';
import { eventually, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// 0.7.3 hosted-run lifecycle (#362, #363, #365): a stale claim can be taken over and must not
// block deletion of a disabled, paused or revoked agent; the run that lost its claim must not
// release or overwrite its successor's state; and a skipped attempt keeps the trigger and events
// that started it. The scheduler is driven directly with a clock, like hosted-agents.test.ts.

const DB_NAME = runScoped('am_test_hosted_lifecycle');
const PORT = testPort(3501);
const DAY = 86_400_000;
const random = seededRandom();
/** Beyond every schedule (a weekly run is at most seven days away). */
const DUE = () => new Date(Date.now() + 8 * DAY);

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let llm: Awaited<ReturnType<typeof fakeLlm>>;

/** One model request held open until the test resolves it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Holds the run's model request open, chosen per test by a marker in the agent's instructions.
 * Returning null leaves the request to the default answer.
 */
let gate: ((r: FakeRequest) => FakeReply | Promise<FakeReply> | null) | null = null;

function answer(r: FakeRequest): FakeReply | Promise<FakeReply> {
  const gated = gate?.(r);
  if (gated) return gated;
  if (r.user.includes('[fail]')) return { status: 500, error: 'the model is unavailable' };
  return { text: 'Run finished.' };
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

/** Keep every other test's hosted agent out of this sweep, and make this one due. */
const onlyDue = (agentId: string) =>
  t.srv.db.admin.query(
    `UPDATE hosted_agents SET next_run_at = CASE WHEN agent_id = $1 THEN now() - interval '1 minute' ELSE now() + interval '100 years' END`,
    [agentId],
  );

/** Keep every hosted agent out of the scheduled sweep. */
const noneDue = () => t.srv.db.admin.query(`UPDATE hosted_agents SET next_run_at = now() + interval '100 years'`);

interface Setup {
  owner: User;
  ws: string;
  api: ReturnType<Server['api']>;
  agentId: string;
}

let unique = 0;

async function setup(instructions: string, opts: { name?: string; schedule?: string } = {}): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-v073-hosted-${n}-${Date.now()}@example.com`);
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
    monthlyTokenBudget: null,
  });
  const hosted = await api.call('agents.createHosted', {
    name: opts.name ?? `v073 hosted ${n}`,
    instructions,
    schedule: opts.schedule ?? 'daily:07:00',
    scopes: ['artifacts:read', 'audit:read'],
    maxTokensPerRun: 20_000,
    maxToolCallsPerRun: 10,
  });
  return { owner, ws, api, agentId: hosted.agentId };
}

interface HostedRow {
  running_run_id: string | null;
  running_started_at: Date | null;
  consecutive_failures: number;
  enabled: boolean;
  next_run_at: Date | null;
}

async function hostedRow(s: Setup): Promise<HostedRow | undefined> {
  const { rows } = await t.srv.db.admin.query<HostedRow>(
    `SELECT running_run_id, running_started_at, consecutive_failures, enabled, next_run_at
     FROM hosted_agents WHERE workspace_id = $1 AND agent_id = $2`,
    [s.ws, s.agentId],
  );
  return rows[0];
}

const hostedRows = async (s: Setup) =>
  (await t.srv.db.admin.query('SELECT 1 FROM hosted_agents WHERE workspace_id = $1 AND agent_id = $2', [s.ws, s.agentId])).rows;

interface RunRow {
  id: string;
  status: string;
  summary: string;
  error: string | null;
  trigger: string;
  event_ids: number[];
}

async function runRows(s: Setup): Promise<RunRow[]> {
  const { rows } = await t.srv.db.admin.query<RunRow>(
    `SELECT id, status, summary, error, trigger, event_ids
     FROM hosted_agent_runs WHERE workspace_id = $1 AND agent_id = $2 ORDER BY started_at, id`,
    [s.ws, s.agentId],
  );
  return rows;
}

/** A claim as a crashed run leaves it: `minutesAgo` old, or with no start time at all. */
async function claim(s: Setup, minutesAgo: number | null, runId = 'har_stale_claim') {
  if (minutesAgo === null) {
    await t.srv.db.admin.query(
      `UPDATE hosted_agents SET running_run_id = $3, running_started_at = NULL WHERE workspace_id = $1 AND agent_id = $2`,
      [s.ws, s.agentId, runId],
    );
    return;
  }
  await t.srv.db.admin.query(
    `UPDATE hosted_agents SET running_run_id = $3, running_started_at = now() - ($4 * interval '1 minute')
     WHERE workspace_id = $1 AND agent_id = $2`,
    [s.ws, s.agentId, runId, minutesAgo],
  );
}

/** Backdate the claim this run took past the stale window, and make the agent due again. */
async function staleAndDue(s: Setup, runId: string) {
  await t.srv.db.admin.query(
    `UPDATE hosted_agents SET running_started_at = now() - interval '2 hours', next_run_at = now() - interval '1 minute'
     WHERE workspace_id = $1 AND agent_id = $2 AND running_run_id = $3`,
    [s.ws, s.agentId, runId],
  );
}

/** An event on the hosted agent's trigger subscription, as the events sweep records it. */
async function addEvent(s: Setup, summary: string, at = new Date()): Promise<number> {
  const { rows } = await t.srv.db.admin.query<{ trigger_subscription_id: string }>(
    'SELECT trigger_subscription_id FROM hosted_agents WHERE agent_id = $1',
    [s.agentId],
  );
  const { rows: inserted } = await t.srv.db.admin.query<{ id: string }>(
    `INSERT INTO agent_events (workspace_id, agent_id, subscription_id, type, event_key, summary, subject, at)
     VALUES ($1, $2, $3, 'guardrail.breach', $4, $5, '{"episodeId":"gde_x"}', $6) RETURNING id`,
    [s.ws, s.agentId, rows[0]!.trigger_subscription_id, `k-${random()}`, summary, at],
  );
  return Number(inserted[0]!.id);
}

/** Scheduler replicas waiting on the claim UPDATE, which a row lock in the test is holding. */
async function claimWaiters(): Promise<number> {
  // pg_locks is readable by every role; pg_stat_activity.query is not, so count the waiters
  // rather than matching their SQL text.
  const { rows } = await t.srv.db.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE a.datname = current_database() AND NOT l.granted AND a.pid <> pg_backend_pid()`,
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_hosted_lifecycle', PORT);
}, 120_000);

beforeEach(() => {
  outbox.length = 0;
  gate = null;
});

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('stale claims and deletion (#362)', () => {
  it('deletes a disabled, paused or revoked agent whose claim is stale', async () => {
    for (const state of ['disabled', 'paused', 'revoked'] as const) {
      const s = await setup('Report the week.', { name: `Delete ${state}` });
      await claim(s, 120);
      if (state === 'disabled') await s.api.call('agents.updateHosted', { agentId: s.agentId, enabled: false });
      if (state === 'paused') await s.api.call('agents.pause', { id: s.agentId, reason: 'Gone' });
      if (state === 'revoked') await s.api.call('agents.revoke', { id: s.agentId, reason: 'Gone' });

      await expect(s.api.call('agents.deleteHosted', { agentId: s.agentId })).resolves.toEqual({ deleted: true });
      expect(await hostedRows(s)).toHaveLength(0);
      expect(await runRows(s)).toHaveLength(0);
    }
  }, 60_000);

  it('still refuses while the claim is live, and treats a claim with no start time as stale', async () => {
    const live = await setup('Report the week.', { name: 'Live claim' });
    await claim(live, 5);
    await expect(live.api.call('agents.deleteHosted', { agentId: live.agentId })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('A run is going'),
    });
    expect(await hostedRows(live)).toHaveLength(1);

    // A claim with no start time cannot be shown live; it must not block forever either.
    const unstarted = await setup('Report the week.', { name: 'Unstarted claim' });
    await claim(unstarted, null);
    await expect(unstarted.api.call('agents.deleteHosted', { agentId: unstarted.agentId })).resolves.toEqual({ deleted: true });
    expect(await hostedRows(unstarted)).toHaveLength(0);
  }, 60_000);

  it('serializes a rename and deletion without reversing their row lock order', async () => {
    const s = await setup('Report the week.', { name: 'Concurrent rename and delete' });
    await claim(s, 120);
    const editor = new pg.Client({ connectionString: testDatabaseUrl(DB_NAME).toString() });
    await editor.connect();
    let deletion: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await editor.query('BEGIN');
      // updateHosted writes the agent row first, then the hosted row. Pause between them.
      await editor.query('UPDATE agents SET name = $2 WHERE id = $1', [s.agentId, 'Renamed']);
      deletion = s.api.call('agents.deleteHosted', { agentId: s.agentId }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect(await eventually(claimWaiters, (n) => n >= 1)).toBeGreaterThanOrEqual(1);
      await editor.query('UPDATE hosted_agents SET updated_at = now() WHERE agent_id = $1', [s.agentId]);
      await editor.query('COMMIT');
      expect(await deletion).toEqual({ value: { deleted: true } });
      expect(await hostedRows(s)).toHaveLength(0);
    } finally {
      await editor.query('ROLLBACK').catch(() => {});
      await editor.end();
      await deletion;
    }
  }, 60_000);

  it('a run that finishes after its agent was deleted records nothing and does not throw', async () => {
    const s = await setup('[late-ok] A run that outlives its deletion.', { name: 'Deleted mid-run' });
    await onlyDue(s.agentId);
    const first = deferred<FakeReply>();
    const firstSeen = deferred<void>();
    let calls = 0;
    gate = (r) => {
      if (!r.user.includes('[late-ok]')) return null;
      calls++;
      if (calls === 1) {
        firstSeen.resolve();
        return first.promise;
      }
      return null;
    };
    const runA = runAt(DUE());
    await firstSeen.promise;
    const claimA = (await hostedRow(s))!.running_run_id;
    expect(claimA).toBeTruthy();

    // The claim is stale, so deletion is allowed while the process is still alive (#362).
    await staleAndDue(s, claimA!);
    await expect(s.api.call('agents.deleteHosted', { agentId: s.agentId })).resolves.toEqual({ deleted: true });

    first.resolve({ text: 'Too late to report.' });
    await expect(runA).resolves.toMatchObject({ ok: 1, failed: 0 });
    // Nothing was recreated, no run history came back, and no mail went out.
    expect(await hostedRows(s)).toHaveLength(0);
    expect(await runRows(s)).toHaveLength(0);
    expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Hosted agent'))).toHaveLength(0);
  }, 60_000);
});

describe('late completion after a stale takeover (#363)', () => {
  it('does not clear the successor’s claim or overwrite its state', async () => {
    const s = await setup('[late-ok] A run that outlives its claim.', { name: 'Late ok' });
    await onlyDue(s.agentId);
    const first = deferred<FakeReply>();
    const firstSeen = deferred<void>();
    const second = deferred<FakeReply>();
    const secondSeen = deferred<void>();
    let calls = 0;
    gate = (r) => {
      if (!r.user.includes('[late-ok]')) return null;
      calls++;
      if (calls === 1) {
        firstSeen.resolve();
        return first.promise;
      }
      if (calls === 2) {
        secondSeen.resolve();
        return second.promise;
      }
      return null;
    };
    try {
      // Run A starts and stays in its model call.
      const runA = runAt(DUE());
      await firstSeen.promise;
      const claimA = (await hostedRow(s))!.running_run_id;
      expect(claimA).toBeTruthy();

      // A sweep takes the stale claim over: run B now owns it and is still in flight.
      await staleAndDue(s, claimA!);
      const runB = runAt(DUE());
      await secondSeen.promise;
      const claimB = (await hostedRow(s))!.running_run_id;
      expect(claimB).toBeTruthy();
      expect(claimB).not.toBe(claimA);

      // A finishes late: its outcome is recorded, but B's claim and state are untouched.
      first.resolve({ text: 'A finished late.' });
      await expect(runA).resolves.toMatchObject({ ok: 1, failed: 0 });
      expect((await hostedRow(s))!.running_run_id).toBe(claimB);
      expect(await hostedRow(s)).toMatchObject({ consecutive_failures: 0, enabled: true });
      const afterA = await runRows(s);
      expect(afterA.find((r) => r.id === claimA)).toMatchObject({ status: 'ok', summary: 'A finished late.' });
      expect(afterA.find((r) => r.id === claimB)).toBeUndefined();

      // B finishes normally and releases its own claim.
      second.resolve({ text: 'B finished.' });
      await expect(runB).resolves.toMatchObject({ ok: 1, failed: 0 });
      expect((await hostedRow(s))!.running_run_id).toBeNull();
      const afterB = await runRows(s);
      expect(afterB).toHaveLength(2);
      expect(afterB.every((r) => r.status === 'ok')).toBe(true);
    } finally {
      gate = null;
    }
  }, 60_000);

  it('does not advance the failure streak or disable the agent; the successor’s failure still does', async () => {
    const s = await setup('[late-fail] A run that fails after its claim.', { name: 'Late fail' });
    await onlyDue(s.agentId);
    // Two earlier failures: a late third failure must not disable the agent (#363).
    await t.srv.db.admin.query(`UPDATE hosted_agents SET consecutive_failures = 2 WHERE workspace_id = $1 AND agent_id = $2`, [
      s.ws,
      s.agentId,
    ]);
    const first = deferred<FakeReply>();
    const firstSeen = deferred<void>();
    const second = deferred<FakeReply>();
    const secondSeen = deferred<void>();
    let calls = 0;
    gate = (r) => {
      if (!r.user.includes('[late-fail]')) return null;
      calls++;
      if (calls === 1) {
        firstSeen.resolve();
        return first.promise;
      }
      if (calls === 2) {
        secondSeen.resolve();
        return second.promise;
      }
      // A retry of either failing run (the client retries a 5xx once).
      return { status: 500, error: 'still failing' };
    };
    try {
      const runA = runAt(DUE());
      await firstSeen.promise;
      const claimA = (await hostedRow(s))!.running_run_id;
      await staleAndDue(s, claimA!);
      const runB = runAt(DUE());
      await secondSeen.promise;
      const claimB = (await hostedRow(s))!.running_run_id;
      expect(claimB).not.toBe(claimA);

      first.resolve({ status: 500, error: 'A failed late.' });
      await expect(runA).resolves.toMatchObject({ failed: 1, disabled: 0 });
      // A's late failure is not counted: the streak and the ownership stay B's.
      expect(await hostedRow(s)).toMatchObject({
        running_run_id: claimB,
        consecutive_failures: 2,
        enabled: true,
      });
      expect((await runRows(s)).find((r) => r.id === claimA)).toMatchObject({ status: 'failed' });
      expect(outbox.filter((m) => m.to === s.owner.email && m.subject.startsWith('Hosted agent disabled'))).toHaveLength(0);

      second.resolve({ status: 500, error: 'B failed.' });
      await expect(runB).resolves.toMatchObject({ failed: 1, disabled: 1 });
      // B's own failure is the third in a row and disables the agent.
      expect(await hostedRow(s)).toMatchObject({
        running_run_id: null,
        consecutive_failures: 3,
        enabled: false,
        next_run_at: null,
      });
      const disabledMail = outbox.find((m) => m.to === s.owner.email && m.subject.startsWith('Hosted agent disabled'));
      expect(disabledMail).toBeTruthy();
      expect(disabledMail!.text).toContain('disabled');
    } finally {
      gate = null;
    }
  }, 60_000);
});

describe('skipped attempts keep their trigger (#365)', () => {
  it('ignores skipped attempts for event admission but still counts a real run', async () => {
    const s = await setup('Check the event.', { name: 'Skip accounting' });
    await s.api.call('agents.updateHosted', {
      agentId: s.agentId,
      triggers: ['guardrail.breach'],
      eventMinGapMinutes: 5,
      eventRunsPerDay: 1,
    });
    await noneDue();
    const now = new Date();
    await t.srv.db.admin.query(
      `INSERT INTO hosted_agent_runs (workspace_id, id, agent_id, started_at, finished_at, status, trigger)
       VALUES ($1, $2, $3, $4, $4, 'skipped', 'event')`,
      [s.ws, `har_${'d'.repeat(32)}`, s.agentId, now],
    );
    await addEvent(s, 'First unread event.', now);
    expect(await runAt(now)).toMatchObject({ ok: 1 });
    expect((await runRows(s)).filter((r) => r.status === 'ok')).toHaveLength(1);
    await addEvent(s, 'Wait for the real run cap.', new Date(now.getTime() + 1000));
    expect(await runAt(new Date(now.getTime() + 1000))).toMatchObject({ ok: 0 });
    expect((await runRows(s)).filter((r) => r.status === 'ok')).toHaveLength(1);
  }, 60_000);

  it('records a lost event-run claim as an event with its events, and a paused scheduled attempt as schedule', async () => {
    const s = await setup('Check the event.', { name: 'Event skip' });
    await noneDue();
    await s.api.call('agents.updateHosted', {
      agentId: s.agentId,
      triggers: ['guardrail.breach'],
      eventMinGapMinutes: 5,
      eventRunsPerDay: 5,
    });
    const eventId = await addEvent(s, 'Unsubscribe rate 3%.');

    // Two scheduler replicas select the event run, then both try to claim it: one wins, one
    // records a skipped attempt. A row lock on the claim makes that ordering deterministic.
    const locker = new pg.Client({ connectionString: testDatabaseUrl(DB_NAME).toString() });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM hosted_agents WHERE workspace_id = $1 AND agent_id = $2 FOR UPDATE', [s.ws, s.agentId]);
      const first = runAt(new Date());
      const second = runAt(new Date());
      const waiting = await eventually(claimWaiters, (n) => n >= 2, 10_000);
      expect(waiting).toBeGreaterThanOrEqual(2);
      await locker.query('COMMIT');
      const summaries = await Promise.all([first, second]);
      expect(summaries.reduce((n, x) => n + x.ok, 0)).toBe(1);
      expect(summaries.reduce((n, x) => n + x.skipped, 0)).toBe(1);
    } finally {
      await locker.end().catch(() => {});
    }

    const rows = await runRows(s);
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(1);
    const skipped = rows.filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ trigger: 'event', event_ids: [eventId] });

    // A scheduled attempt skipped because the agent is paused stays a scheduled attempt.
    const paused = await setup('Check the schedule.', { name: 'Paused schedule' });
    await onlyDue(paused.agentId);
    await paused.api.call('agents.pause', { id: paused.agentId, reason: 'Paused' });
    await runAt(new Date());
    const pausedRows = await runRows(paused);
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]).toMatchObject({ status: 'skipped', trigger: 'schedule', event_ids: [] });
  }, 60_000);
});
