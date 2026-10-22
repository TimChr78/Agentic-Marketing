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
}

export interface Db {
  admin: pg.Pool;
  app: pg.Pool;
  /**
   * Run `fn` in one transaction scoped to a workspace; RLS reads `app.workspace_id`.
   * `snapshot: true` (repeatable read) makes every statement see the same data, for reads that
   * combine several queries and must not see a concurrent change half-applied.
   */
  withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>, opts?: { snapshot?: boolean }): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDb(config: DbConfig): Db {
  const admin = new pg.Pool({ connectionString: config.adminUrl, max: 5 });
  const app = new pg.Pool({ connectionString: config.appUrl, max: config.poolSize ?? 20 });
  return {
    admin,
    app,
    async withWorkspace(workspaceId, fn, opts) {
      const client = await app.connect();
      try {
        await client.query(opts?.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const result = await fn(drizzle(client, { schema }));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
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
