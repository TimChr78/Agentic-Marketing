import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #982 review (Sol, round 3): an expired key reused while its old action is being undone must not
// inherit the reversal. The executor's replacement (plain DELETE of the expired row, then INSERT a
// fresh row) and agents.undo's statement (packages/auth/src/agents.ts, a single UPDATE joined to
// `idempotency_key_actions`) race in both orders. The undo statement only reaches rows still
// linked to the undone action, and the old row's links cascade away with its delete, so the fresh
// row always ends with `reversed_at IS NULL` — a replay of the new response, never
// `idempotency_key_reversed`.
//
// Both orders are coordinated through pg_locks: each test starts the second statement without
// awaiting it, then waits until PostgreSQL reports the backend blocked, and only then commits the
// first transaction. No sleeps and no fixed delays decide the outcome.

let d: DisposableDb;
const clients: pg.PoolClient[] = [];

interface RaceHarness {
  undo: pg.PoolClient;
  replace: pg.PoolClient;
}

async function raceClients(): Promise<RaceHarness> {
  const undo = await d.db.admin.connect();
  const replace = await d.db.admin.connect();
  clients.push(undo, replace);
  return { undo, replace };
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

/** Wait until PostgreSQL reports this backend waiting on a lock, with no timed sleep. */
async function waitUntilBlocked(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await d.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted', [pid]);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`the second statement on backend ${pid} never blocked on the first`);
}

/** An agent ledger row a stored response describes. */
async function insertAction(): Promise<number> {
  const { rows } = await d.db.admin.query<{ id: number }>(
    `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
     VALUES ($1, 'agt_race', 'artifacts.requestPublish', 'content.publish', 'allow', true, 'rest')
     RETURNING id`,
    [d.workspace],
  );
  return rows[0]!.id;
}

/** The state an expired key has just before it is reused: old row plus its action link. */
async function seedExpiredKey(key: string, actionId: number): Promise<void> {
  await d.db.admin.query(
    `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response, created_at)
     VALUES ($1, $2, 'artifacts.requestPublish', 'old-hash', '{"status":"old"}'::jsonb, now() - make_interval(days => 31))`,
    [d.workspace, key],
  );
  await d.db.admin.query('INSERT INTO idempotency_key_actions (workspace_id, key, agent_action_id) VALUES ($1, $2, $3)', [
    d.workspace,
    key,
    actionId,
  ]);
}

/** agents.undo's statement, verbatim from packages/auth/src/agents.ts (keep in sync). */
function undoStatement(client: pg.PoolClient, actionId: number, undoneAt: Date) {
  return client.query(
    `UPDATE idempotency_keys k
        SET reversed_at = $3
       FROM idempotency_key_actions a
      WHERE a.workspace_id = $1
        AND a.agent_action_id = $2
        AND k.workspace_id = a.workspace_id
        AND k.key = a.key`,
    [d.workspace, actionId, undoneAt],
  );
}

/** The executor's replacement: delete only the expired row, then insert the fresh response. */
function replaceExpired(client: pg.PoolClient, key: string) {
  return client.query(
    `DELETE FROM idempotency_keys
      WHERE workspace_id = $1 AND key = $2
        AND created_at <= now() - make_interval(days => 30)`,
    [d.workspace, key],
  );
}

function insertFresh(client: pg.PoolClient, key: string) {
  return client.query(
    `INSERT INTO idempotency_keys (workspace_id, key, command, input_hash, response)
     VALUES ($1, $2, 'artifacts.requestPublish', 'fresh-hash', '{"status":"fresh"}'::jsonb)`,
    [d.workspace, key],
  );
}

async function freshState(key: string) {
  const { rows } = await d.db.admin.query<{ response: { status: string }; reversed_at: Date | null }>(
    'SELECT response, reversed_at FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
    [d.workspace, key],
  );
  const { rows: links } = await d.db.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM idempotency_key_actions WHERE workspace_id = $1 AND key = $2',
    [d.workspace, key],
  );
  return { row: rows[0], links: links[0]?.n };
}

describe.skipIf(!hasTestDatabase())('an undone action races an expired key being reused (#982)', () => {
  beforeAll(async () => {
    d = await createDisposableDb('idem_race');
  });

  afterAll(async () => {
    for (const client of clients) client.release();
    await d?.close();
  });

  it('when undo commits first, the replacement deletes the reversed row and its links', async () => {
    const key = 'race-undo-first';
    const actionId = await insertAction();
    await seedExpiredKey(key, actionId);
    const { undo, replace } = await raceClients();

    await undo.query('BEGIN');
    try {
      const reversed = await undoStatement(undo, actionId, new Date());
      expect(reversed.rowCount).toBe(1);

      // The replacement's DELETE now waits on the row undo holds.
      await replace.query('BEGIN');
      const pid = await backendPid(replace);
      const deleting = replaceExpired(replace, key);
      await waitUntilBlocked(pid);
      await undo.query('COMMIT');

      expect((await deleting).rowCount).toBe(1);
      await insertFresh(replace, key);
      await replace.query('COMMIT');
    } catch (err) {
      await undo.query('ROLLBACK').catch(() => {});
      await replace.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // The fresh row has no reversal and no links: the replay gate (`hit.reversedAt`) lets it
    // answer its own response instead of 409 idempotency_key_reversed.
    const { row, links } = await freshState(key);
    expect(row?.response).toEqual({ status: 'fresh' });
    expect(row?.reversed_at).toBeNull();
    expect(links).toBe(0);
  });

  it('when the replacement commits first, undo blocks, finds no link, and leaves the fresh row alone', async () => {
    const key = 'race-reuse-first';
    const actionId = await insertAction();
    await seedExpiredKey(key, actionId);
    const { undo, replace } = await raceClients();

    await replace.query('BEGIN');
    try {
      expect((await replaceExpired(replace, key)).rowCount).toBe(1);
      await insertFresh(replace, key);

      // Undo's joined UPDATE now waits on the rows the replacement deleted (the link and the key).
      await undo.query('BEGIN');
      const pid = await backendPid(undo);
      const undoing = undoStatement(undo, actionId, new Date());
      await waitUntilBlocked(pid);
      await replace.query('COMMIT');

      // The old row and its link are gone, so the statement reaches nothing: never the fresh row.
      expect((await undoing).rowCount).toBe(0);
      await undo.query('COMMIT');
    } catch (err) {
      await replace.query('ROLLBACK').catch(() => {});
      await undo.query('ROLLBACK').catch(() => {});
      throw err;
    }

    const { row, links } = await freshState(key);
    expect(row?.response).toEqual({ status: 'fresh' });
    expect(row?.reversed_at).toBeNull();
    expect(links).toBe(0);
  });
});
