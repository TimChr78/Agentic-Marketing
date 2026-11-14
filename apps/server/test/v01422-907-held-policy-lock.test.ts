import { runHeldChange, systemContext } from '@agentic-marketing/artifacts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGuardianOnce } from '../src/agents/guardian';
import { runHoldsOnce } from '../src/agents/holds';
import { startTestServer, testPort, type User } from './harness';

// #907: the guardian and the policy engine serialise on the `agent-policy:<ws>:<agent>` advisory
// lock, but the held-change runner took no lock: it read `status = active, guard = null`, the
// guardian then committed a pause, and the runner published anyway. The runner now holds the same
// lock for its check and its publish, in one transaction, so a guardian commit serialises with it.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  // The background hold loop stays out of the way: every round in this file is explicit.
  t = await startTestServer('test_v01422_907', testPort(4463), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01422-907-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const guardianDeps = () => ({
  db: t.srv.db,
  services: t.srv.services,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

/** The part of a raw connection these checks use. */
interface Queryable {
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** Waits (bounded) until some backend is queued for an advisory lock in this test's database. */
async function waitForAdvisoryWaiter(conn: Queryable, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const { rows } = await conn.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - started > timeoutMs) throw new Error('no backend waited for the agent-policy lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An agent whose mandate holds content publishes for a veto window. */
async function agentSetup() {
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', { name: 'Held lock agent', scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] })
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
    content: { agent: agentId, purpose: 'Test the held-change lock', validUntil: inDays(30), levels: { 'content.publish': 2 } } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { ws, api, token, agentId, agentCall };
}

/** An agent drafts a note and asks to publish it; at level 2 it waits in a veto window. */
async function heldNote(s: Awaited<ReturnType<typeof agentSetup>>, title: string) {
  const created = await s.agentCall('artifacts.create', {
    type: 'note',
    name: title,
    content: { title, body: 'A note from the agent held by a veto window.' },
  });
  expect(created.status).toBe(200);
  const held = await s.agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: `${title}: intent` });
  expect(held.body.status).toBe('on_hold');
  return {
    artifactId: created.body.artifactId as string,
    approvalId: held.body.approvalId as string,
    version: held.body.version as number,
  };
}

/** The veto window of a pending hold has passed. */
const endHoldWindow = (ws: string, approvalId: string) =>
  t.srv.db.withWorkspace(ws, (tx) =>
    tx.execute(sql`UPDATE approval_requests SET hold_until = now() - interval '1 minute'
      WHERE workspace_id = ${ws} AND id = ${approvalId}`),
  );

const artifactRow = async (ws: string, id: string) =>
  (
    await t.srv.db.admin.query<{ archived: boolean; published_version: number | null }>(
      'SELECT archived, published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0];

const approvalRow = async (ws: string, id: string) =>
  (
    await t.srv.db.admin.query<{ status: string; note: string; hold_until: Date | null }>(
      'SELECT status, note, hold_until FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0];

describe('the held-change runner shares the agent-policy lock (#907)', () => {
  it('a pause committed by the guardian while it holds the lock stops the run and is recorded', async () => {
    const s = await agentSetup();
    const held = await heldNote(s, 'Paused while held');
    const lockConn = await t.srv.db.admin.connect();
    try {
      await lockConn.query('BEGIN');
      // The guardian decides under its lock; the held runner starts while the lock is still held.
      await lockConn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agent-policy:${s.ws}:${s.agentId}`]);
      await endHoldWindow(s.ws, held.approvalId);
      const round = runHoldsOnce({ db: t.srv.db, services: t.srv.services });
      await waitForAdvisoryWaiter(lockConn);
      // The guardian's pause commits; it was decided before the runner could look.
      await lockConn.query('UPDATE agents SET status = $3, status_reason = $4 WHERE workspace_id = $1 AND id = $2', [
        s.ws,
        s.agentId,
        'paused',
        'The guardian paused it: an anomaly.',
      ]);
      await lockConn.query('COMMIT');
      await round;
    } finally {
      await lockConn.query('ROLLBACK').catch(() => {});
      lockConn.release();
    }

    // Nothing went live, and the request says why instead of staying a live hold.
    expect(await artifactRow(s.ws, held.artifactId)).toMatchObject({ published_version: null });
    const approval = await approvalRow(s.ws, held.approvalId);
    expect(approval?.status).toBe('pending');
    expect(approval?.hold_until).toBeNull();
    expect(approval?.note).toMatch(/Not run after its veto window/i);
    expect(approval?.note).toMatch(/paused/i);
  }, 60_000);

  it('a guardian round that starts while the held runner holds the lock waits, then applies its pause', async () => {
    const s = await agentSetup();
    const held = await heldNote(s, 'Runs before the pause');
    await endHoldWindow(s.ws, held.approvalId);
    // Ten refusals in the last hour: the guardian's probing rule pauses the agent.
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
       SELECT $1, $2, 'messages.sendEmail', 'send.direct', 'deny', false, 'internal' FROM generate_series(1, 10)`,
      [s.ws, s.agentId],
    );

    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The check runs under the lock: hold it there until the guardian is queued for it.
    const runner = t.srv.db.withWorkspace(s.ws, (tx) =>
      runHeldChange(systemContext(tx, s.ws, t.srv.services), held.approvalId, async () => {
        locked();
        await mayFinish;
        return { run: true };
      }),
    );
    await lockHeld;

    const probe = await t.srv.db.admin.connect();
    try {
      const guardianRound = runGuardianOnce(guardianDeps());
      try {
        await waitForAdvisoryWaiter(probe);
      } finally {
        // The runner finishes before the guardian may proceed: its change goes live, then the
        // guardian's pause commits.
        release();
      }
      const outcome = await runner;
      await guardianRound;
      expect(outcome).toMatchObject({ status: 'published' });
    } finally {
      probe.release();
    }

    expect(await artifactRow(s.ws, held.artifactId)).toMatchObject({ published_version: held.version });
    const agent = await t.srv.db.admin.query<{ status: string }>('SELECT status FROM agents WHERE workspace_id = $1 AND id = $2', [
      s.ws,
      s.agentId,
    ]);
    expect(agent.rows[0]?.status).toBe('paused');
    const episodes = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM guardian_events WHERE workspace_id = $1 AND agent_id = $2 AND action = 'pause'",
      [s.ws, s.agentId],
    );
    expect(episodes.rows[0]?.n).toBe(1);
  }, 60_000);
});
