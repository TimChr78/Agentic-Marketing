import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate';
import { createDb } from '../src/pool';

// A throwaway database for package-level SQL tests. It is never the shared test template: each
// caller gets its own freshly migrated database and drops it afterwards, so package tests can run
// next to the server project without resetting anyone else's data.

export const APP_ROLE = { appRole: 'am_ops_test_app', appRolePassword: 'am_ops_test_password' };

export const hasTestDatabase = () => Boolean(process.env.TEST_DATABASE_URL);

function urlOf(name: string): URL {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  url.pathname = `/${name}`;
  return url;
}

export interface DisposableDb {
  db: ReturnType<typeof createDb>;
  url: URL;
  workspace: string;
  close(): Promise<void>;
}

export interface DisposableDbOptions {
  /** Stop at this migration (inclusive), so a test can seed and then apply the newer ones. */
  upTo?: string;
  appRole?: string;
  appRolePassword?: string;
}

export async function createDisposableDb(prefix: string, opts: DisposableDbOptions = {}): Promise<DisposableDb> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `am_${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`;
  const maint = new pg.Client({ connectionString: urlOf('postgres').toString() });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maint.query(`CREATE DATABASE ${name}`);
  } finally {
    await maint.end();
  }
  const url = urlOf(name);
  const db = createDb({ adminUrl: url.toString(), appUrl: url.toString(), poolSize: 2 });
  await migrate(db.admin, {
    appRole: opts.appRole ?? APP_ROLE.appRole,
    appRolePassword: opts.appRolePassword ?? APP_ROLE.appRolePassword,
    upTo: opts.upTo,
  });
  const workspace = randomUUID();
  await db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [workspace, `Test ${prefix}`, 'none']);
  return {
    db,
    url,
    workspace,
    async close() {
      await db.close();
      const m = new pg.Client({ connectionString: urlOf('postgres').toString() });
      await m.connect();
      try {
        await m.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await m.end();
      }
    },
  };
}
