// Helpers for the identity-lock protocol tests (#978 part 3). A test coordinates with barriers and
// observes the real advisory locks through `pg_locks`; nothing here sleeps to "let things settle",
// every wait is for a lock state that must appear (with a timeout so a broken test fails, not hangs).

export const identityKey = (workspaceId: string) => `identity:${workspaceId}`;

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** The part of a pooled connection these tests use (a `pg.PoolClient` satisfies it). */
export interface ClientLike extends Queryable {
  release(): void;
}

/** The part of a pool these tests use (a `pg.Pool` satisfies it). */
export interface PoolLike {
  connect(): Promise<ClientLike>;
}

const TIMEOUT_MS = 10_000;
const POLL_MS = 20;

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

/** Takes the workspace identity lock in its own transaction, so a test can hold it as a barrier. */
export async function holdIdentityLock(pool: PoolLike, workspaceId: string) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identityKey(workspaceId)]);
  return {
    client,
    async release() {
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
    async rollback() {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  };
}

/** The SQL predicate for this workspace's advisory lock, as seen in `pg_locks`. */
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
export async function waitForLockHolderBlocked(conn: Queryable, workspaceId: string, blockingPid: number): Promise<number> {
  return waitFor(`the holder of ${identityKey(workspaceId)} to wait for backend ${blockingPid}`, async () => {
    const { rows } = await conn.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.wait_event_type = 'Lock' AND ${blockingPid} = ANY(pg_blocking_pids(a.pid))
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

/**
 * Waits until a backend is both granted the identity lock and queued on another lock. The blocking
 * backend's pid is not needed: the caller holds the only other lock the batch can want.
 */
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

/**
 * Releases when `parties` callers arrive, or after `timeoutMs` so one skipped call cannot hang the
 * suite. The same shape as `prepared-keys.test.ts`, shared here for the protocol tests.
 */
export function barrier(parties: number, timeoutMs = 0) {
  let arrived = 0;
  let released = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  if (timeoutMs) setTimeout(release, timeoutMs).unref();
  return async () => {
    if (released) return;
    arrived++;
    if (arrived >= parties) release();
    await gate;
  };
}

/** The advisory key the pause trigger waits on: one fixed name, never a workspace or a person. */
export const CONSENT_PAUSE_KEY = 'test:pause-consent-insert';

/**
 * Installs a BEFORE INSERT trigger on `consent_records` that waits on a test advisory lock. A test
 * holds that lock to stop a writer *after* it resolved the canonical profile and *before* the
 * evidence row lands — the only point where a merge can otherwise slip in between and leave the
 * refusal on a merged-away profile. The trigger is dropped again by `dropConsentPause`.
 */
export async function installConsentPause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_consent_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${CONSENT_PAUSE_KEY}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_consent_insert ON consent_records;
    CREATE TRIGGER test_pause_consent_insert BEFORE INSERT ON consent_records
      FOR EACH ROW EXECUTE FUNCTION test_pause_consent_insert();`);
}

export async function dropConsentPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_consent_insert ON consent_records');
}

/** Takes the session-level lock the pause trigger waits on. */
export async function holdConsentPause(conn: ClientLike): Promise<void> {
  await conn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [CONSENT_PAUSE_KEY]);
}

export async function releaseConsentPause(conn: ClientLike): Promise<void> {
  await conn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [CONSENT_PAUSE_KEY]);
}

/** The advisory key the topic pause trigger waits on. */
export const TOPIC_PAUSE_KEY = 'test:pause-topic-history';

/**
 * Installs a BEFORE INSERT trigger on `topic_preference_history` that waits on a test advisory
 * lock. A test holds that lock to stop a topic write after it resolved the canonical profile and
 * upserted the choice but before it commits, so a merge or an erasure can be started while the
 * writer holds the identity lock.
 */
export async function installTopicPause(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE OR REPLACE FUNCTION test_pause_topic_history() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${TOPIC_PAUSE_KEY}', 0));
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS test_pause_topic_history ON topic_preference_history;
    CREATE TRIGGER test_pause_topic_history BEFORE INSERT ON topic_preference_history
      FOR EACH ROW EXECUTE FUNCTION test_pause_topic_history();`);
}

export async function dropTopicPause(conn: Queryable): Promise<void> {
  await conn.query('DROP TRIGGER IF EXISTS test_pause_topic_history ON topic_preference_history');
}

export async function holdTopicPause(conn: ClientLike): Promise<void> {
  await conn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [TOPIC_PAUSE_KEY]);
}

export async function releaseTopicPause(conn: ClientLike): Promise<void> {
  await conn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [TOPIC_PAUSE_KEY]);
}
