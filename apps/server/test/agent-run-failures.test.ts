import { runRetentionOnce } from '@agentic-marketing/audience';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Wave 5, Phase 24 (B2, #445): agents.runFailures is the workspace's recent failed hosted runs in
// one bounded read — failed only, newest first, with the agent name, a since bound and a keyset
// cursor over (startedAt, id).

const PORT = testPort(3512);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let ws2 = '';
let digest = '';
let lifecycle = '';
let other = '';

const iso = (at: string) => new Date(at).toISOString();

const createAgent = async (workspace: string, name: string) =>
  (
    await t.api(owner, workspace).call('agents.createHosted', {
      name,
      instructions: 'Summarise the week.',
      schedule: 'weekly:mon:07:00',
      scopes: ['artifacts:read'],
    })
  ).agentId;

const insertRun = (
  workspace: string,
  id: string,
  agentId: string,
  startedAt: string,
  runStatus: 'ok' | 'failed' | 'skipped',
  error: string | null,
) =>
  t.srv.db.admin.query(
    `INSERT INTO hosted_agent_runs (workspace_id, id, agent_id, started_at, finished_at, status, summary, tool_calls, tokens, error, trigger)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,10,$8,'schedule')`,
    [workspace, id, agentId, iso(startedAt), iso(startedAt), runStatus, `${runStatus} summary`, error],
  );

const failures = (input: any, workspace = ws) => t.api(owner, workspace).call('agents.runFailures', input);

beforeAll(async () => {
  t = await startTestServer('test_run_failures', PORT);
  owner = await t.signUp(`owner-run-failures-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  ws2 = await t.workspaceWith([[owner, 'owner']], 'none');
  digest = await createAgent(ws, 'Nightly digest');
  lifecycle = await createAgent(ws, 'Lifecycle');
  other = await createAgent(ws2, 'Other workspace agent');

  await insertRun(ws, 'hrn_00000000000000000000000000000001', digest, '2026-10-07T09:00:00Z', 'failed', 'Provider timeout');
  await insertRun(ws, 'hrn_00000000000000000000000000000002', lifecycle, '2026-10-06T09:00:00Z', 'failed', 'Tool call refused');
  await insertRun(ws, 'hrn_00000000000000000000000000000003', digest, '2026-10-05T09:00:00Z', 'failed', null);
  await insertRun(ws, 'hrn_00000000000000000000000000000004', lifecycle, '2026-10-04T09:00:00Z', 'failed', 'Budget exhausted');
  await insertRun(ws, 'hrn_00000000000000000000000000000005', digest, '2026-10-03T09:00:00Z', 'failed', 'Model unavailable');
  await insertRun(ws, 'hrn_00000000000000000000000000000006', lifecycle, '2026-10-03T09:00:00Z', 'failed', 'Rate limited');
  await insertRun(ws, 'hrn_00000000000000000000000000000007', digest, '2026-10-02T09:00:00Z', 'failed', 'Malformed answer');
  // Outside the since bound, and successful/skipped runs that are not failures.
  await insertRun(ws, 'hrn_00000000000000000000000000000008', digest, '2026-08-01T09:00:00Z', 'failed', 'Old failure');
  await insertRun(ws, 'hrn_00000000000000000000000000000009', digest, '2026-10-08T09:00:00Z', 'ok', null);
  await insertRun(ws, 'hrn_00000000000000000000000000000010', lifecycle, '2026-10-09T09:00:00Z', 'skipped', null);
  await insertRun(ws2, 'hrn_00000000000000000000000000000011', other, '2026-10-07T09:00:00Z', 'failed', 'Other workspace');
}, 120_000);

afterAll(() => t?.close());

describe('agents.runFailures (B2)', () => {
  it('returns only failed runs since the bound, newest first, with agent names', async () => {
    const out = await failures({ since: '2026-09-01T00:00:00Z', limit: 100 });
    expect(out.runs).toHaveLength(7);
    expect(out.runs.every((r) => r.status === 'failed')).toBe(true);
    expect(out.runs.map((r) => r.id)).not.toContain('hrn_00000000000000000000000000000008');
    expect(out.runs.map((r) => r.id)).not.toContain('hrn_00000000000000000000000000000009');
    expect(out.runs.map((r) => r.id)).not.toContain('hrn_00000000000000000000000000000010');
    expect(out.runs.map((r) => r.id)).not.toContain('hrn_00000000000000000000000000000011');

    const names = new Map([
      [digest, 'Nightly digest'],
      [lifecycle, 'Lifecycle'],
    ]);
    for (const run of out.runs) expect(run.agentName).toBe(names.get(run.agentId));
    expect(out.runs[0]).toMatchObject({ id: 'hrn_00000000000000000000000000000001', error: 'Provider timeout' });
    expect(out.runs[0]!.startedAt).toBe(iso('2026-10-07T09:00:00Z'));
    expect(out.nextCursor).toBeNull();
    expect(out.asOf).toEqual(expect.any(String));

    const expected = [...out.runs].sort((a, b) =>
      a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1,
    );
    expect(out.runs.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(out.runs.map((r) => r.id).slice(4, 6)).toEqual(['hrn_00000000000000000000000000000006', 'hrn_00000000000000000000000000000005']);
  });

  it('pages the tied and untied runs with a stable cursor and no repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await failures({ since: '2026-09-01T00:00:00Z', limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.runs.map((r) => r.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe('hrn_00000000000000000000000000000001');
    expect(seen.at(-1)).toBe('hrn_00000000000000000000000000000007');
  });

  it('rejects a malformed cursor instead of restarting', async () => {
    await expect(failures({ since: '2026-09-01T00:00:00Z', cursor: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('has indexes for the failure queue and contact-pressure count (#488)', async () => {
    const indexes = await t.srv.db.admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE (tablename = 'hosted_agent_runs' AND indexname = 'hosted_agent_runs_status_started')
          OR (tablename = 'messages' AND indexname = 'messages_agent_contact_count')`,
    );
    expect(indexes.rows.map((r) => r.indexname).sort()).toEqual(['hosted_agent_runs_status_started', 'messages_agent_contact_count']);
  });

  it('removes finished hosted-agent runs past their retention (#488)', async () => {
    const day = 86_400_000;
    await insertRun(ws, 'hrn_00000000000000000000000000000012', digest, new Date(Date.now() - 120 * day).toISOString(), 'ok', null);
    await insertRun(ws, 'hrn_00000000000000000000000000000013', digest, new Date(Date.now() - 10 * day).toISOString(), 'ok', null);
    const removed = await runRetentionOnce({ db: t.srv.db, events: t.srv.events, ...t.srv.retention, hostedAgentRunDays: 90 });
    expect(removed.hostedAgentRuns).toBeGreaterThanOrEqual(1);
    const rows = await t.srv.db.admin.query<{ id: string }>(
      `SELECT id FROM hosted_agent_runs WHERE workspace_id = $1 AND id IN ('hrn_00000000000000000000000000000012', 'hrn_00000000000000000000000000000013') ORDER BY id`,
      [ws],
    );
    expect(rows.rows.map((r) => r.id)).toEqual(['hrn_00000000000000000000000000000013']);
  });
});
