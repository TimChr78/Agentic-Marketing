import { activeMandates, repairActiveMandates } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #911 review (A1): the SQL repair in 0094 ranked by parseable expiry and updated_at, but the
// runtime skips a mandate whose content fails the full schema. With an older valid mandate and a
// newer schema-invalid one, SQL archived the valid one and kept the unusable one, so the agent
// lost its mandate. The repair now runs in code, under the `am.agent-mandate` lock, and keeps
// exactly what `activeMandates` picks.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_911r', testPort(4464), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01422-911r-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** A published mandate artifact, as a pre-fix install left duplicates behind. */
async function seedMandate(ws: string, content: unknown, opts: { name: string; updatedMinutesAgo: number }) {
  const id = newId('mnd');
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, created_at, updated_at)
     VALUES ($1, $2, 'agent_mandate', $3, 1, 1, now() - interval '30 days', now() - make_interval(mins => $4))`,
    [ws, id, opts.name, opts.updatedMinutesAgo],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', $5)`,
    [ws, id, content, `hash-${id}`, owner.id],
  );
  return id;
}

const valid = (agent: string, purpose = 'Act for this workspace') => ({ agent, purpose, validUntil: inDays(30) });
const invalid = (agent: string) => ({ agent, purpose: '', validUntil: inDays(30) });

/** What the policy engine uses for one agent, exactly as the runtime computes it. */
const activeId = (ws: string, agentId: string) =>
  t.srv.db.withWorkspace(ws, (tx) => activeMandates(tx, [agentId])).then((map) => map.get(agentId)?.view.id ?? null);

/** The part of a raw connection these checks use. */
interface RawConn {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** What the runtime uses for one agent at a given time. */
const activeIdAt = (ws: string, agentId: string, at: Date) =>
  t.srv.db.withWorkspace(ws, (tx) => activeMandates(tx, [agentId], at)).then((map) => map.get(agentId)?.view.id ?? null);

const archivedOf = async (ws: string, ids: string[]) => {
  const { rows } = await t.srv.db.admin.query<{ id: string; archived: boolean; name: string }>(
    'SELECT id, archived, name FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY id',
    [ws, ids],
  );
  return rows;
};

describe('the single-active-mandate repair keeps what the runtime uses (#911 A1)', () => {
  it('keeps an older valid mandate over a newer one the runtime skips', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const olderValid = await seedMandate(ws, valid(agent), { name: 'Older valid', updatedMinutesAgo: 60 * 24 * 3 });
    const newerInvalid = await seedMandate(ws, invalid(agent), { name: 'Newer invalid', updatedMinutesAgo: 10 });

    const before = await activeId(ws, agent);
    expect(before).toBe(olderValid);

    const out = await repairActiveMandates(t.srv.db);
    expect(out.archived).toContain(newerInvalid);

    // The runtime's answer does not change, and the unusable row is the one archived.
    expect(await activeId(ws, agent)).toBe(before);
    expect(await archivedOf(ws, [olderValid, newerInvalid])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: newerInvalid, archived: true, name: `Newer invalid (archived duplicate ${newerInvalid})` }),
        expect.objectContaining({ id: olderValid, archived: false }),
      ]),
    );
  });

  it('breaks an equal updated_at tie the same way the runtime does and does not change the answer', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const first = await seedMandate(ws, valid(agent), { name: 'First', updatedMinutesAgo: 30 });
    const second = await seedMandate(ws, valid(agent), { name: 'Second', updatedMinutesAgo: 30 });
    await t.srv.db.admin.query(
      'UPDATE artifacts SET updated_at = (SELECT updated_at FROM artifacts WHERE id = $1) WHERE workspace_id = $2 AND id = $3',
      [first, ws, second],
    );

    const before = await activeId(ws, agent);
    await repairActiveMandates(t.srv.db);
    expect(await activeId(ws, agent)).toBe(before);
    // The runtime orders by updated_at and then id, so the higher id wins.
    expect(before).toBe([first, second].sort().at(-1));
    const rows = await archivedOf(ws, [first, second]);
    expect(rows.filter((r) => !r.archived).map((r) => r.id)).toEqual([before]);
  });

  it('never lets an expired mandate win over a valid one', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const expired = await seedMandate(
      ws,
      { agent, purpose: 'Expired', validUntil: inDays(-1) },
      {
        name: 'Expired',
        updatedMinutesAgo: 1,
      },
    );
    const validRow = await seedMandate(ws, valid(agent, 'Still valid'), { name: 'Valid', updatedMinutesAgo: 60 * 24 });

    expect(await activeId(ws, agent)).toBe(validRow);
    await repairActiveMandates(t.srv.db);
    expect(await activeId(ws, agent)).toBe(validRow);
    expect(await archivedOf(ws, [expired, validRow])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expired, archived: true }),
        expect.objectContaining({ id: validRow, archived: false }),
      ]),
    );
  });

  it('leaves other agents, single mandates and already repaired workspaces alone', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const repairedAgent = newId('agt');
    const kept = await seedMandate(ws, valid(repairedAgent), { name: 'Kept', updatedMinutesAgo: 60 });
    const gone = await seedMandate(ws, valid(repairedAgent), { name: 'Gone', updatedMinutesAgo: 120 });
    const otherAgent = newId('agt');
    const otherOnly = await seedMandate(ws, invalid(otherAgent), { name: 'Other agent', updatedMinutesAgo: 60 });

    const first = await repairActiveMandates(t.srv.db);
    expect(first.archived).toEqual([gone]);
    expect(await archivedOf(ws, [kept, gone, otherOnly])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: kept, archived: false }),
        expect.objectContaining({ id: gone, archived: true }),
        expect.objectContaining({ id: otherOnly, archived: false }),
      ]),
    );

    // Recorded once per workspace; the next run finds nothing to do.
    const recorded = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM data_repairs WHERE name = 'single_active_mandate' AND workspace_id = $1",
      [ws],
    );
    expect(recorded.rows[0]?.n).toBe(1);
    expect((await repairActiveMandates(t.srv.db)).archived).toEqual([]);
  });

  // #922 round 3: the repair locks artifact rows in id order and only then takes the mandate lock,
  // the same order a person's publish uses, so the two cannot deadlock on the same artifact.

  /**
   * Waits (bounded) until a backend is queued for this transaction id: the repair is blocked on the
   * row the publisher locked. A row-lock wait is an xid wait, which is not database-scoped, so this
   * looks the transaction up directly.
   */
  async function waitForTransactionWaiter(conn: RawConn, xid: string, timeoutMs = 10_000) {
    const started = Date.now();
    for (;;) {
      const { rows } = await conn.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'transactionid' AND transactionid = $1::xid AND NOT granted`,
        [xid],
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() - started > timeoutMs) throw new Error('no backend waited for the publisher transaction');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const mandatoryLock = (ws: string, agent: string) =>
    t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('am.agent-mandate'), hashtext(${`${ws}:${agent}`}))`),
    );

  it('does not deadlock with a publish request that holds an artifact row, and both finish', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const older = await seedMandate(ws, valid(agent, 'Older'), { name: 'Older', updatedMinutesAgo: 120 });
    const newer = await seedMandate(ws, valid(agent, 'Newer'), { name: 'Newer', updatedMinutesAgo: 10 });

    const publisher = await t.srv.db.admin.connect();
    let repair: ReturnType<typeof repairActiveMandates> | undefined;
    try {
      await publisher.query('BEGIN');
      // A person's publish locks the artifact in `impact` before it reaches the mandate validator.
      await publisher.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, older]);
      const xid = (await publisher.query<{ xid: string }>('SELECT txid_current()::text AS xid')).rows[0]!.xid;
      repair = repairActiveMandates(t.srv.db);
      await waitForTransactionWaiter(publisher, xid);
      // The publish now asks for the mandate lock. With the old order the repair held it and waited
      // for this row, so this statement was the second arm of a deadlock.
      await publisher.query("SET LOCAL statement_timeout = '10s'");
      await mandatoryLock(ws, agent);
      await publisher.query('COMMIT');
    } finally {
      await publisher.query('ROLLBACK').catch(() => {});
      publisher.release();
    }
    const out = await repair!;

    expect(out.archived).toEqual([older]);
    expect(await archivedOf(ws, [older, newer])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: older, archived: true }),
        expect.objectContaining({ id: newer, archived: false }),
      ]),
    );
  }, 60_000);

  it('re-evaluates a group that changed while it waited, and keeps the remaining mandate', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const older = await seedMandate(ws, valid(agent, 'Older'), { name: 'Older', updatedMinutesAgo: 120 });
    const newer = await seedMandate(ws, valid(agent, 'Newer'), { name: 'Newer', updatedMinutesAgo: 10 });

    const blocker = await t.srv.db.admin.connect();
    let repair: ReturnType<typeof repairActiveMandates> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, older]);
      const xid = (await blocker.query<{ xid: string }>('SELECT txid_current()::text AS xid')).rows[0]!.xid;
      repair = repairActiveMandates(t.srv.db);
      await waitForTransactionWaiter(blocker, xid);
      // While the repair waits, another writer archives the newer duplicate (a person, or an
      // earlier pass): the group no longer has two live mandates.
      await t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, newer]);
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const out = await repair!;

    // The stale read would have archived the older one; the re-read keeps it.
    expect(out.archived).toEqual([]);
    expect(await archivedOf(ws, [older, newer])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: older, archived: false }),
        expect.objectContaining({ id: newer, archived: true }),
      ]),
    );
  }, 60_000);

  it('selects at the time of the group, not the start of the pass', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    // Group order is by agent id, so the first agent is processed before the second.
    const firstAgent = `agt_${'0'.repeat(32)}`;
    const secondAgent = `agt_${'1'.repeat(32)}`;
    await seedMandate(ws, valid(firstAgent), { name: 'First kept', updatedMinutesAgo: 60 });
    await seedMandate(ws, valid(firstAgent), { name: 'First gone', updatedMinutesAgo: 90 });
    const base = new Date();
    const expiring = await seedMandate(
      ws,
      { agent: secondAgent, purpose: 'Expires soon', validUntil: new Date(base.getTime() + 30_000).toISOString() },
      {
        name: 'Expires soon',
        updatedMinutesAgo: 1,
      },
    );
    const validOld = await seedMandate(
      ws,
      { agent: secondAgent, purpose: 'Valid for a month', validUntil: inDays(30) },
      {
        name: 'Valid for a month',
        updatedMinutesAgo: 1_440,
      },
    );

    // The pass reached the second group two minutes after it started: the newest mandate expired
    // in the meantime, so the runtime already uses the older one.
    let calls = 0;
    const atDecision = new Date(base.getTime() + 120_000);
    const out = await repairActiveMandates(t.srv.db, {
      clock: () => new Date(calls++ === 0 ? base.getTime() : atDecision.getTime()),
    });

    expect(out.archived).toContain(expiring);
    expect(out.archived).not.toContain(validOld);
    expect(await archivedOf(ws, [expiring, validOld])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expiring, archived: true }),
        expect.objectContaining({ id: validOld, archived: false }),
      ]),
    );
    // ... which is exactly what the runtime picks at the decision time.
    expect(await activeIdAt(ws, secondAgent, atDecision)).toBe(validOld);
  });

  it('leaves a group untouched when no mandate in it is usable', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const broken1 = await seedMandate(ws, { agent, purpose: '', validUntil: inDays(30) }, { name: 'Broken one', updatedMinutesAgo: 60 });
    const broken2 = await seedMandate(ws, { agent, purpose: '', validUntil: inDays(30) }, { name: 'Broken two', updatedMinutesAgo: 30 });
    const logs: string[] = [];

    const out = await repairActiveMandates(t.srv.db, { log: (msg) => logs.push(msg) });

    // Nothing is archived: the runtime uses neither row, and guessing could archive the only one a
    // person will fix. The group is reported instead.
    expect(out.archived).toEqual([]);
    expect(await archivedOf(ws, [broken1, broken2])).toEqual([
      expect.objectContaining({ id: broken1, archived: false }),
      expect.objectContaining({ id: broken2, archived: false }),
    ]);
    expect(logs.join(' ')).toMatch(/none is usable/);
  });

  it('repairs the other groups when one fails, leaves the workspace unrecorded, and the next pass finishes it', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    // Group order is by agent id: the first group is repaired before the second one runs.
    const firstAgent = `agt_${'0'.repeat(32)}`;
    const secondAgent = `agt_${'1'.repeat(32)}`;
    const firstKept = await seedMandate(ws, valid(firstAgent), { name: 'First kept', updatedMinutesAgo: 60 });
    const firstGone = await seedMandate(ws, valid(firstAgent), { name: 'First gone', updatedMinutesAgo: 90 });
    const secondKept = await seedMandate(ws, valid(secondAgent), { name: 'Second kept', updatedMinutesAgo: 60 });
    const secondGone = await seedMandate(ws, valid(secondAgent), { name: 'Second gone', updatedMinutesAgo: 90 });

    // The second group's selection throws, standing in for a database error after the first group
    // committed; attempts: 1 keeps the test to one try.
    let calls = 0;
    const failed = await repairActiveMandates(t.srv.db, {
      attempts: 1,
      clock: () => {
        calls++;
        if (calls === 2) throw new Error('injected failure');
        return new Date();
      },
    });

    expect(failed.failed).toEqual([ws]);
    expect(failed.recorded).toEqual([]);
    expect(failed.archived).toEqual([firstGone]);
    const unrecorded = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM data_repairs WHERE name = 'single_active_mandate' AND workspace_id = $1",
      [ws],
    );
    expect(unrecorded.rows[0]?.n).toBe(0);
    expect(await archivedOf(ws, [firstKept, firstGone])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstKept, archived: false }),
        expect.objectContaining({ id: firstGone, archived: true }),
      ]),
    );

    // The next pass (a later scheduler tick, or the next start) finishes the group and records it.
    const retried = await repairActiveMandates(t.srv.db);
    expect(retried.failed).toEqual([]);
    expect(retried.recorded).toContain(ws);
    expect(retried.archived).toEqual([secondGone]);
    expect(await archivedOf(ws, [secondKept, secondGone])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: secondKept, archived: false }),
        expect.objectContaining({ id: secondGone, archived: true }),
      ]),
    );
    const recorded = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM data_repairs WHERE name = 'single_active_mandate' AND workspace_id = $1",
      [ws],
    );
    expect(recorded.rows[0]?.n).toBe(1);
  }, 60_000);
});
