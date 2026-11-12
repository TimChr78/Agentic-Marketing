import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Tx = NodePgDatabase<typeof schema>;

export interface DbConfig {
  /** Owner role: migrations, membership lookups, Better Auth tables. Bypasses RLS. */
  adminUrl: string;
  /** Application role `am_app`: everything the command layer does, always under RLS. */
  appUrl: string;
  poolSize?: number;
  /** Give up on a new connection after this many milliseconds (health checks must not hang). */
  connectionTimeoutMillis?: number;
  /** Abort a query that runs longer than this many milliseconds (health checks must not hang). */
  queryTimeoutMillis?: number;
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
   * waiter must see the winner's row, #812), and releases it after commit or rollback.
   */
  withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>, opts?: { snapshot?: boolean; advisoryLockKey?: string }): Promise<T>;
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
  return {
    admin,
    app,
    async withWorkspace(workspaceId, fn, opts) {
      const client = await app.connect();
      let locked = false;
      try {
        if (opts?.advisoryLockKey) {
          // Session-level and before BEGIN: the snapshot below cannot predate the winner's commit.
          await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [opts.advisoryLockKey]);
          locked = true;
        }
        await client.query(opts?.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const result = await fn(drizzle(client, { schema }));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        // The lock is session-scoped: a rollback or a thrown handler does not release it.
        let unlockFailed = false;
        if (locked) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [opts?.advisoryLockKey]).catch(() => {
            unlockFailed = true;
          });
        }
        // If the unlock could not run, destroy the connection so its backend exits and the lock dies
        // with it; returning it to the pool could hand the next request a still-locked session.
        client.release(unlockFailed ? true : undefined);
      }
    },
    async ping() {
      await app.query('SELECT 1');
    },
    async close() {
      await Promise.all([admin.end(), app.end()]);
    },
  };
}
