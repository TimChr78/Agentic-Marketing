import { runHeldChange, systemContext } from '@agentic-marketing/artifacts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHoldsOnce } from '../src/agents/holds';
import { startTestServer, testPort, type User } from './harness';

// #922 review A2/B: one global lock order. The agent-policy lock comes first, then the approval
// row, then artifact rows, then the mandate validator's lock. A publish request used to lock its
// artifact in `impact` before the executor took the policy lock, so a held run holding the policy
// lock and waiting for the same artifact deadlocked with it (40P01). A manual pause did not take
// the policy lock at all, so it could commit between a held run's check and its publish.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_922', testPort(4465), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01422-922-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** The part of a raw connection these checks use. */
interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const policyKey = (ws: string, agentId: string) => `agent-policy:${ws}:${agentId}`;

/** Waits (bounded) until a backend is queued for this exact agent-policy lock. */
async function waitForPolicyWaiter(conn: Queryable, key: string, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const { rows } = await conn.query<{ n: number }>(
      `WITH t AS (SELECT hashtextextended($1, 0) AS k)
       SELECT count(*)::int AS n
         FROM pg_locks l, t
        WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = ((t.k >> 32) & 4294967295)::oid
          AND l.objid = (t.k & 4294967295)::oid`,
      [key],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - started > timeoutMs) throw new Error(`no backend waited for ${key}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Waits (bounded) until the backend holding this exact agent-policy lock is itself queued on a
 * lock: the held runner has the policy lock and is waiting for the approval row.
 */
async function waitForPolicyHolderBlocked(conn: Queryable, key: string, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const { rows } = await conn.query<{ n: number }>(
      `WITH t AS (SELECT hashtextextended($1, 0) AS k)
       SELECT count(*)::int AS n
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
         CROSS JOIN t
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.classid = ((t.k >> 32) & 4294967295)::oid
          AND l.objid = (t.k & 4294967295)::oid
          AND a.datname = current_database() AND a.wait_event_type = 'Lock'`,
      [key],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - started > timeoutMs) throw new Error(`the holder of ${key} never waited on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An agent whose mandate holds content publishes for a veto window. */
async function agentSetup() {
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', { name: 'Lock order agent', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
  ).token as string;
  const agentCall = async (name: string, body: unknown = {}) => {
    const res = await fetch(`${t.base}/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const agentId = (await agentCall('agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Hold content publishes',
    content: { agent: agentId, purpose: 'Test the lock order', validUntil: inDays(30), levels: { 'content.publish': 2 } } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { ws, api, token, agentId, agentCall };
}

const endHoldWindow = (ws: string, approvalId: string) =>
  t.srv.db.withWorkspace(ws, (tx) =>
    tx.execute(sql`UPDATE approval_requests SET hold_until = now() - interval '1 minute'
      WHERE workspace_id = ${ws} AND id = ${approvalId}`),
  );

describe('one lock order for the agent-policy lock (#922 A2/B)', () => {
  it('a publish request waiting on the policy lock does not deadlock with the held run that holds it', async () => {
    const s = await agentSetup();
    // v1 is held for the veto window; v2 is the draft the concurrent request will publish.
    const created = await s.agentCall('artifacts.create', {
      type: 'note',
      name: 'Contended note',
      content: { title: 'v1', body: 'First version.' },
    });
    const artifactId = created.body.artifactId as string;
    const held = await s.agentCall('artifacts.requestPublish', { artifactId, note: 'Held v1' });
    expect(held.body.status).toBe('on_hold');
    await s.agentCall('artifacts.updateDraft', { artifactId, content: { title: 'v2', body: 'Second version.' }, note: 'v2' });
    await endHoldWindow(s.ws, held.body.approvalId as string);

    // A person's reject holds the approval row: the runner takes the policy lock and waits there,
    // exactly where a veto decision would leave it.
    const blocker = await t.srv.db.admin.connect();
    let ran: number | undefined;
    let request: Promise<{ status: number; body: any }> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM approval_requests WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [s.ws, held.body.approvalId]);
      const round = runHoldsOnce({ db: t.srv.db, services: t.srv.services });
      await waitForPolicyHolderBlocked(blocker, policyKey(s.ws, s.agentId));
      // The agent's publish request starts while the runner holds the policy lock. Its impact must
      // not lock the artifact first: the executor takes the policy lock before it.
      request = s.agentCall('artifacts.requestPublish', { artifactId, note: 'Concurrent v2' });
      await waitForPolicyWaiter(blocker, policyKey(s.ws, s.agentId));
      await blocker.query('COMMIT');
      ran = await round;
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const answer = await request!;

    // The held run published v1 and the request got a clean answer; a 40P01 could only surface as
    // the retryable "same artifacts at the same time" conflict or as a hold that never ran.
    expect(ran).toBe(1);
    // A 40P01 surfaces as the retryable "same artifacts at the same time" conflict.
    expect(answer.body.message ?? '').not.toMatch(/same artifacts at the same time/i);
    expect(answer.body.message ?? '').not.toMatch(/deadlock/i);
    expect(['on_hold', 'published', 'in_review']).toContain(answer.body.status);
    const approval = await t.srv.db.admin.query<{ status: string }>(
      'SELECT status FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [s.ws, held.body.approvalId],
    );
    expect(approval.rows[0]?.status).toBe('approved');
    const artifact = await t.srv.db.admin.query<{ published_version: number }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [s.ws, artifactId],
    );
    expect(artifact.rows[0]?.published_version).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('a manual pause waits for the held run’s lock and applies afterwards', async () => {
    const s = await agentSetup();
    const created = await s.agentCall('artifacts.create', {
      type: 'note',
      name: 'Paused after the run',
      content: { title: 'Held', body: 'Runs before a manual pause.' },
    });
    const artifactId = created.body.artifactId as string;
    const held = await s.agentCall('artifacts.requestPublish', { artifactId, note: 'Held publish' });
    expect(held.body.status).toBe('on_hold');
    await endHoldWindow(s.ws, held.body.approvalId as string);

    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The check runs under the policy lock; hold it there until the pause is queued on it.
    const runner = t.srv.db.withWorkspace(s.ws, (tx) =>
      runHeldChange(systemContext(tx, s.ws, t.srv.services), held.body.approvalId as string, async () => {
        locked();
        await mayFinish;
        return { run: true };
      }),
    );
    await lockHeld;

    const probe = await t.srv.db.admin.connect();
    let pause: Promise<{ status: string }> | undefined;
    try {
      pause = s.api.call('agents.pause', { id: s.agentId, reason: 'A person stopped it' });
      await waitForPolicyWaiter(probe, policyKey(s.ws, s.agentId));
    } finally {
      release();
    }
    await runner;
    await pause;
    probe.release();

    const agent = await t.srv.db.admin.query<{ status: string }>('SELECT status FROM agents WHERE workspace_id = $1 AND id = $2', [
      s.ws,
      s.agentId,
    ]);
    expect(agent.rows[0]?.status).toBe('paused');
    const artifact = await t.srv.db.admin.query<{ published_version: number | null }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [s.ws, artifactId],
    );
    expect(artifact.rows[0]?.published_version).toBe(1);
  }, 60_000);
});
