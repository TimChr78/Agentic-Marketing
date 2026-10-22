import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import * as schema from './schema';

// Two roles on purpose:
// - admin (owner/superuser): migrations and Better Auth tables, bypasses RLS
// - app (am_app, no BYPASSRLS): everything the command layer does, so a missing
//   WHERE clause cannot leak rows across workspaces
export const adminPool = new pg.Pool({ connectionString: config.adminDatabaseUrl, max: 5 });
export const appPool = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 10 });

export type Tx = NodePgDatabase<typeof schema>;

/** Run `fn` in a transaction scoped to one workspace (RLS reads `app.workspace_id`). */
export async function withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn(drizzle(client, { schema }));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools() {
  await Promise.all([adminPool.end(), appPool.end()]);
}
