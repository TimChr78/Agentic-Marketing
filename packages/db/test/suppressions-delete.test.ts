import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #664: START over SMS lifts the SMS stop suppression with a DELETE, but 0004 granted am_app only
// SELECT and INSERT on suppressions, so every opt-in answered 500. 0088 grants DELETE and row-level
// security stays in force: the role may only remove rows of the workspace in app.workspace_id.
//
// The second test runs the migration the way a small self-hosted install does: as a database owner
// without BYPASSRLS, where FORCE RLS applies to the migrator itself.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const appPool = (url: URL) => {
  const appUrl = new URL(url.toString());
  appUrl.username = APP_ROLE.appRole;
  appUrl.password = APP_ROLE.appRolePassword;
  return new pg.Pool({ connectionString: appUrl.toString() });
};

/** Deletes as the app role with app.workspace_id set, exactly as db.withWorkspace does. */
async function deleteAs(
  pool: pg.Pool,
  workspaceId: string,
  filter: { channel: string; valueHash: string; reason: string },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    const res = await client.query(`DELETE FROM suppressions WHERE channel = $1 AND value_hash = $2 AND reason = $3`, [
      filter.channel,
      filter.valueHash,
      filter.reason,
    ]);
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } finally {
    client.release();
  }
}

async function seed() {
  const d = await createDisposableDb('supdel');
  open.push(d);
  const other = '00000000-0000-4000-8000-0000000000aa';
  await d.db.admin.query(`INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other', 'none')`, [other]);
  await d.db.admin.query(
    `INSERT INTO suppressions (workspace_id, channel, value_hash, reason) VALUES
       ($1, 'sms', 'own-stop', 'stop'),
       ($1, 'sms', 'own-bounce', 'hard_bounce'),
       ($2, 'sms', 'other-stop', 'stop')`,
    [d.workspace, other],
  );
  return { d, other };
}

describe.skipIf(!hasTestDatabase())('0088 grants DELETE on suppressions with row-level security', () => {
  it('lets the app role delete its own stop row and no other workspace’s rows', async () => {
    const { d, other } = await seed();
    const pool = appPool(d.url);
    try {
      expect(await deleteAs(pool, d.workspace, { channel: 'sms', valueHash: 'own-stop', reason: 'stop' })).toBe(1);
      // The row of another workspace matches the predicates but not the RLS policy.
      expect(await deleteAs(pool, d.workspace, { channel: 'sms', valueHash: 'other-stop', reason: 'stop' })).toBe(0);
    } finally {
      await pool.end();
    }
    const left = await d.db.admin.query<{ workspace_id: string; value_hash: string; reason: string }>(
      `SELECT workspace_id, value_hash, reason FROM suppressions ORDER BY workspace_id, value_hash`,
    );
    expect(left.rows).toEqual([
      { workspace_id: other, value_hash: 'other-stop', reason: 'stop' },
      { workspace_id: d.workspace, value_hash: 'own-bounce', reason: 'hard_bounce' },
    ]);
  });

  it('applies as a non-superuser owner without BYPASSRLS and still enforces the policy', async () => {
    const d = await createDisposableDb('supdelrls', { upTo: '0087_domain_pending_since.sql' });
    open.push(d);
    const suffix = randomBytes(4).toString('hex');
    const role = `am_supdel_mig_${suffix}`;
    const appRole = `am_supdel_app_${suffix}`;
    await d.db.admin.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    await d.db.admin.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
    // The migration role owns the tables later migrations touch (suppressions for 0088, deliveries
    // for 0089's index, artifacts for 0092's singleton index, artifact_versions for 0093's
    // one-published-version index, workspaces for 0094's data_repairs and 0095's gap table foreign
    // keys, messages for 0096's request fingerprint); FORCE RLS applies to it as well, which is the
    // small-install path this guards.
    for (const table of [
      'artifacts',
      'artifact_versions',
      'suppressions',
      'deliveries',
      'oauth_workspace_selections',
      'workspaces',
      'messages',
    ])
      await d.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
    await d.db.admin.query(`GRANT SELECT, INSERT ON schema_migrations TO ${role}`);

    const limitedUrl = new URL(d.url.toString());
    limitedUrl.username = role;
    limitedUrl.password = 'rls-password';
    const limited = new pg.Pool({ connectionString: limitedUrl.toString() });
    try {
      await migrate(limited, { appRole, appRolePassword: 'rls-app-password' });
    } finally {
      await limited.end();
    }

    const granted = await d.db.admin.query<{ delete: boolean }>(
      `SELECT has_table_privilege($1, 'public.suppressions', 'DELETE') AS delete`,
      [appRole],
    );
    expect(granted.rows[0]?.delete).toBe(true);
    // 0004 would have granted SELECT and INSERT to the production role; DELETE on a column it
    // filters on also needs SELECT, so a real role has all three.
    await d.db.admin.query(`GRANT SELECT, INSERT ON suppressions TO ${appRole}`);

    const other = '00000000-0000-4000-8000-0000000000bb';
    await d.db.admin.query(`INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other', 'none')`, [other]);
    await d.db.admin.query(
      `INSERT INTO suppressions (workspace_id, channel, value_hash, reason) VALUES
         ($1, 'sms', 'rls-own', 'stop'),
         ($2, 'sms', 'rls-other', 'stop')`,
      [d.workspace, other],
    );

    const ownUrl = new URL(d.url.toString());
    ownUrl.username = appRole;
    ownUrl.password = 'rls-app-password';
    const pool = new pg.Pool({ connectionString: ownUrl.toString() });
    try {
      expect(await deleteAs(pool, d.workspace, { channel: 'sms', valueHash: 'rls-own', reason: 'stop' })).toBe(1);
      expect(await deleteAs(pool, d.workspace, { channel: 'sms', valueHash: 'rls-other', reason: 'stop' })).toBe(0);
    } finally {
      await pool.end();
    }
    const left = await d.db.admin.query<{ value_hash: string }>(`SELECT value_hash FROM suppressions WHERE workspace_id = $1`, [other]);
    expect(left.rows).toEqual([{ value_hash: 'rls-other' }]);
  }, 60_000);
});
