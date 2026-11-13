import { AppError } from '@agentic-marketing/core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Tx = NodePgDatabase<typeof schema>;

/**
 * How long an idempotency waiter keeps retrying before it answers `conflict` (HTTP 409). A waiter
 * never blocks on the lock while holding a pooled connection, so this deadline is the only wait.
 */
const ADVISORY_LOCK_TIMEOUT_MS = 10_000;
/** Retry delay after a failed `pg_try_advisory_lock`, doubled and jittered up to the maximum. */
const ADVISORY_LOCK_BACKOFF_START_MS = 20;
const ADVISORY_LOCK_BACKOFF_MAX_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * These are **session** advisory locks: the lock belongs to the PostgreSQL backend that ran the
 * statement. They are incompatible with PgBouncer (or another pooler) in **transaction** pooling
 * mode, where that backend can be handed to a different client between statements; use session
 * pooling or a direct connection. This deployment connects to PostgreSQL directly.
 */

export interface DbConfig {
  /** Owner role: migrations, membership lookups, Better Auth tables. Bypasses RLS. */
  adminUrl: string;
  /** Application role `am_app`: everything the command layer does, always under RLS. */
  appUrl: string;
  poolSize?: number;
  /**
   * Called when an idle pooled connection fails (the server restarted, a failover, an administrator
   * terminated it). pg emits that failure on the pool itself; without a listener Node treats it as
   * an unhandled 'error' event and exits the process, although the pool only replaces the client.
   * The server wires this to its telemetry logger; the default only emits a process warning.
   */
  onIdleError?: (err: Error, pool: 'admin' | 'app') => void;
  /** Give up on a new connection after this many milliseconds (health checks must not hang). */
  connectionTimeoutMillis?: number;
  /** Abort a query that runs longer than this many milliseconds (health checks must not hang). */
  queryTimeoutMillis?: number;
  /** How long an idempotency waiter retries the advisory lock before `conflict`. Default 10 s. */
  advisoryLockTimeoutMillis?: number;
}

export interface Db {
  admin: pg.Pool;
  app: pg.Pool;
  /**
   * Run `fn` in one transaction scoped to a workspace; RLS reads `app.workspace_id`.
   * `snapshot: true` (repeatable read) makes every statement see the same data, for reads that
   * combine several queries and must not see a concurrent change half-applied.
   * `advisoryLockKey` takes a session-level advisory lock on the same connection *before* `BEGIN`,
   * so a repeatable-read snapshot is taken after the previous holder commits (the idempotency
   * waiter must see the winner's row, #812), and releases it after commit or rollback. The lock is
   * acquired with `pg_try_advisory_lock` only while a connection is checked out: a waiter releases
   * its connection between attempts, so a holder can still open another `withWorkspace`, and gives
   * up with `conflict` (HTTP 409) after the timeout instead of deadlocking the pool.
   */
  withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Tx) => Promise<T>,
    opts?: {
      snapshot?: boolean;
      advisoryLockKey?: string;
      /**
       * A non-tenant capability key that stays visible across workspaces for the same session,
       * e.g. the pending OAuth consent choice (#838). The table's policy must name the matching
       * setting; it never widens access to tenant tables.
       */
      sessionId?: string;
    },
  ): Promise<T>;
  /**
   * Run `fn` in one transaction scoped to a non-tenant session key instead of a workspace. Only
   * tables whose row-level-security policy names `app.oauth_selection_session` see anything:
   * today that is the pending OAuth consent choice, which belongs to the session rather than to
   * one tenant. Never use it for tenant rows.
   */
  withSession<T>(sessionId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDb(config: DbConfig): Db {
  const timeouts = {
    ...(config.connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis: config.connectionTimeoutMillis }),
    ...(config.queryTimeoutMillis === undefined ? {} : { query_timeout: config.queryTimeoutMillis }),
  };
  const admin = new pg.Pool({ connectionString: config.adminUrl, max: 5, ...timeouts });
  const app = new pg.Pool({ connectionString: config.appUrl, max: config.poolSize ?? 20, ...timeouts });
  const onIdleError =
    config.onIdleError ??
    ((err: Error, pool: 'admin' | 'app') => {
      // The message can name the server and the role, but never the connection string or password.
      process.emitWarning(`Postgres ${pool} pool: an idle connection failed (${err.message}); it was removed from the pool.`);
    });
  admin.on('error', (err) => onIdleError(err, 'admin'));
  app.on('error', (err) => onIdleError(err, 'app'));
  const lockTimeout = config.advisoryLockTimeoutMillis ?? ADVISORY_LOCK_TIMEOUT_MS;

  const lockStillBusy = () =>
    new AppError(
      'conflict',
      'A request with this idempotency key is still in progress. Retry with the same key after it has finished; a new key would run the operation again.',
    );

  /** A pooled connection, or null when the deadline passes while the pool has none to give. */
  const connectWithin = async (deadline: number): Promise<pg.PoolClient | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const pending = app.connect();
    const client = await Promise.race([pending, timedOut]);
    clearTimeout(timer);
    if (client) return client;
    // The pool may still hand this connection over after the deadline: return it when it does,
    // instead of leaking it for the life of the process.
    pending.then((late) => late.release()).catch(() => {});
    return null;
  };

  /**
   * Take the session advisory lock without waiting while holding a connection. One holder plus
   * `poolSize - 1` blocked waiters used to take every connection, so a holder that needed another
   * `withWorkspace` (an AI step's budget transactions, say) could never finish: a deadlock.
   */
  const acquireAdvisoryLock = async (key: string, deadline: number): Promise<pg.PoolClient> => {
    let delay = ADVISORY_LOCK_BACKOFF_START_MS;
    for (;;) {
      const client = await connectWithin(deadline);
      if (!client) throw lockStillBusy();
      let acquired: boolean;
      try {
        const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key]);
        acquired = rows[0]?.locked === true;
      } catch (err) {
        // The backend's lock state is uncertain: a client-side timeout can arrive after PostgreSQL
        // granted the lock. Destroy the connection so a late grant dies with its backend instead of
        // leaking onto a pooled session that the next request would inherit.
        client.release(true);
        throw err;
      }
      if (acquired) return client;
      client.release();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lockStillBusy();
      // Jitter keeps several waiters from retrying in lockstep against the same holder.
      await sleep(Math.min(remaining, delay * (0.5 + Math.random() * 0.5)));
      delay = Math.min(delay * 2, ADVISORY_LOCK_BACKOFF_MAX_MS);
    }
  };

  /** One transaction with the given `app.*` settings, which row-level-security policies read. */
  const runScoped = async <T>(
    settings: readonly [string, string][],
    fn: (tx: Tx) => Promise<T>,
    opts?: { snapshot?: boolean; advisoryLockKey?: string },
  ): Promise<T> => {
    const deadline = Date.now() + lockTimeout;
    let client: pg.PoolClient | undefined;
    let locked = false;
    try {
      if (opts?.advisoryLockKey) {
        // Session-level and before BEGIN: the snapshot below cannot predate the winner's commit.
        client = await acquireAdvisoryLock(opts.advisoryLockKey, deadline);
        locked = true;
      } else {
        client = await app.connect();
      }
      await client.query(opts?.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      for (const [name, value] of settings) await client.query('SELECT set_config($1, $2, true)', [name, value]);
      const result = await fn(drizzle(client, { schema }));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (client) {
        // The lock is session-scoped: a rollback or a thrown handler does not release it.
        let unlockFailed = false;
        if (locked) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [opts?.advisoryLockKey]).catch(() => {
            unlockFailed = true;
          });
        }
        // If the unlock could not run, destroy the connection so its backend exits and the lock
        // dies with it; returning it to the pool could hand the next request a still-locked session.
        client.release(unlockFailed ? true : undefined);
      }
    }
  };

  return {
    admin,
    app,
    withWorkspace(workspaceId, fn, opts) {
      return runScoped(
        [
          ['app.workspace_id', workspaceId],
          ...(opts?.sessionId ? ([['app.oauth_selection_session', opts.sessionId]] as [string, string][]) : []),
        ],
        fn,
        opts,
      );
    },
    withSession(sessionId, fn) {
      return runScoped([['app.oauth_selection_session', sessionId]], fn);
    },
    async ping() {
      await app.query('SELECT 1');
    },
    async close() {
      await Promise.all([admin.end(), app.end()]);
    },
  };
}
