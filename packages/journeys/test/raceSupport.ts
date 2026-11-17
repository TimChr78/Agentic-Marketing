// Helpers for the journey/merge race tests (#1011). Same style as
// `packages/profiles/test/lockSupport.ts`: real PostgreSQL locks observed through `pg_locks`, and
// pause triggers that stop a transaction at a named point instead of a sleep. Nothing here waits
// for "a while"; every barrier is a lock state that must appear, with a bounded timeout so a broken
// test fails instead of hanging.

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
const lockRow = (granted: boolean) => `
  SELECT pid FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND ${granted ? '' : 'NOT '}l.granted
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
     AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid`;

/** Backends granted the workspace identity lock. */
export async function identityHolders(conn: Queryable, workspaceId: string): Promise<number[]> {
  const { rows } = await conn.query<{ pid: number }>(lockRow(true), [identityKey(workspaceId)]);
  return rows.map((r) => r.pid);
}

/** Waits until at least one backend is queued on the workspace identity lock. */
export async function waitForIdentityWaiter(conn: Queryable, workspaceId: string): Promise<number> {
  return waitFor(`a waiter on ${identityKey(workspaceId)}`, async () => {
    const { rows } = await conn.query<{ pid: number }>(lockRow(false), [identityKey(workspaceId)]);
    return rows[0]?.pid;
  });
}

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

/** The advisory keys the pause triggers wait on: fixed test names, never a workspace or a person. */
export const MERGE_COMMIT_PAUSE_KEY = 'test:pause-profile-merge-insert';
export const IDENTIFIER_PAUSE_KEY = 'test:pause-identifier-move';

/**
 * Stops a merge after it moved the participant rows and before it commits: the trigger waits on a
 * session advisory lock the test holds, so a hook or a sweep that starts now is still outside the
 * merge's transaction.
 */
export async function installMergeCommitPause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_merge_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${MERGE_COMMIT_PAUSE_KEY}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_merge_insert ON profile_merges;
    CREATE TRIGGER test_pause_merge_insert BEFORE INSERT ON profile_merges
      FOR EACH ROW EXECUTE FUNCTION test_pause_merge_insert();`);
}

export async function dropMergeCommitPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_merge_insert ON profile_merges');
}

/**
 * Stops a merge while it moves identifiers, after it locked the profile rows and read their traits
 * but before it writes the merged traits or moves a participant row.
 */
export async function installIdentifierPause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_identifier_move() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${IDENTIFIER_PAUSE_KEY}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_identifier_move ON identifiers;
    CREATE TRIGGER test_pause_identifier_move BEFORE UPDATE ON identifiers
      FOR EACH ROW EXECUTE FUNCTION test_pause_identifier_move();`);
}

export async function dropIdentifierPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_identifier_move ON identifiers');
}

/** Takes the session-level lock a pause trigger waits on. */
export async function holdPause(conn: ClientLike, key: string): Promise<void> {
  await conn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
}

export async function releasePause(conn: ClientLike, key: string): Promise<void> {
  await conn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
}
