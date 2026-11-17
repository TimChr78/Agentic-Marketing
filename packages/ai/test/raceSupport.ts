// Helpers for the AI worker's lock-order race tests (#1011 review). Same style as
// `packages/profiles/test/lockSupport.ts`: a pause trigger stops a merge at a named point and the
// test observes real locks through `pg_locks`, so nothing depends on timing.

const TIMEOUT_MS = 10_000;
const POLL_MS = 20;

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** The part of a pooled connection these tests use (a `pg.PoolClient` satisfies it). */
export interface ClientLike extends Queryable {
  release(): void;
}

export const identityKey = (workspaceId: string) => `identity:${workspaceId}`;

/** Waits (bounded) for `predicate` to hold. A predicate that never holds fails the test. */
export async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false | null>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The SQL predicate for one advisory key, as seen in `pg_locks`. */

/** Waits until a backend holds the identity lock and is itself blocked on another lock. */
export async function waitForAdvisoryHolderBlocked(conn: Queryable, workspaceId: string): Promise<number> {
  return waitFor(`the holder of ${identityKey(workspaceId)} to wait on a lock`, async () => {
    const { rows } = await conn.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.wait_event_type = 'Lock'
          AND EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted
                         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                         AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
                         AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid)`,
      [identityKey(workspaceId)],
    );
    return rows[0]?.pid;
  });
}

/** Backends blocked by `pid`, i.e. `pid` holds a lock they want. */
export async function blockedBy(conn: Queryable, pid: number): Promise<number[]> {
  const { rows } = await conn.query<{ pid: number }>(
    `SELECT a.pid FROM pg_stat_activity a
      WHERE a.wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(a.pid))`,
    [pid],
  );
  return rows.map((r) => r.pid);
}

export const IDENTIFIER_PAUSE_KEY = 'test:pause-ai-identifier-move';
/**
 * Stops a merge while it moves identifiers: it has locked the profile rows (the fix under test) and
 * has not yet moved a participant row or written the merged traits.
 */
export async function installIdentifierPause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_ai_identifier_move() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${IDENTIFIER_PAUSE_KEY}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_ai_identifier_move ON identifiers;
    CREATE TRIGGER test_pause_ai_identifier_move BEFORE UPDATE ON identifiers
      FOR EACH ROW EXECUTE FUNCTION test_pause_ai_identifier_move();`);
}

export async function dropIdentifierPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_ai_identifier_move ON identifiers');
}

/** Takes the session-level lock the pause trigger waits on. */
export async function holdPause(conn: ClientLike, key: string): Promise<void> {
  await conn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
}

export async function releasePause(conn: ClientLike, key: string): Promise<void> {
  await conn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
}
