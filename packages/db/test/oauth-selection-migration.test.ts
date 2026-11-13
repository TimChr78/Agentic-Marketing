import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #838 rolling upgrade: a Helm pre-upgrade migration runs while the previous API pods still serve,
// and a rollback brings 0.14.15 back. Those pods choose a consent brand with
// `INSERT … ON CONFLICT (session_id)`, so 0091 must keep the single-column unique key. The new code
// replaces the same row through the session-scoped policy instead of changing the key.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('0091 keeps the 0.14.15 consent-selection statements working', () => {
  it('applies over an existing selection and still accepts the old upsert verbatim', async () => {
    const d = await createDisposableDb('oauthsel', { upTo: '0090_suppressions_update_grant.sql' });
    open.push(d);
    const other = randomUUID();
    await d.db.admin.query(`INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other', 'none')`, [other]);
    await d.db.admin.query(`INSERT INTO oauth_workspace_selections (session_id, workspace_id) VALUES ('legacy-request', $1)`, [
      d.workspace,
    ]);

    // The upgrade applies 0091 to a database that already has a pending choice.
    await migrate(d.db.admin, { appRole: APP_ROLE.appRole, appRolePassword: APP_ROLE.appRolePassword });

    // v0.14.15, unchanged: packages/auth/src/oauthWorkspace.ts at that tag.
    await d.db.admin.query(
      `INSERT INTO oauth_workspace_selections (session_id, workspace_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET workspace_id = excluded.workspace_id, updated_at = now()`,
      ['legacy-request', other],
    );

    const { rows } = await d.db.admin.query<{ session_id: string; workspace_id: string }>(
      `SELECT session_id, workspace_id FROM oauth_workspace_selections ORDER BY session_id`,
    );
    expect(rows).toEqual([{ session_id: 'legacy-request', workspace_id: other }]);
  });

  it('keeps the old delete and read statements meaningful', async () => {
    const d = await createDisposableDb('oauthselold');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO oauth_workspace_selections (session_id, workspace_id, created_at, updated_at)
       VALUES ('expired-legacy', $1, now() - interval '2 days', now() - interval '2 days'),
              ('fresh-legacy', $1, now(), now())`,
      [d.workspace],
    );

    // v0.14.15 cleanup and consume, unchanged. The old reader used the owner pool.
    await d.db.admin.query(`DELETE FROM oauth_workspace_selections WHERE updated_at < now() - interval '1 day'`);
    const consumed = await d.db.admin.query<{ workspace_id: string }>(
      'DELETE FROM oauth_workspace_selections WHERE session_id = $1 RETURNING workspace_id',
      ['fresh-legacy'],
    );
    expect(consumed.rows).toEqual([{ workspace_id: d.workspace }]);
    const left = await d.db.admin.query<{ session_id: string }>('SELECT session_id FROM oauth_workspace_selections');
    expect(left.rows).toEqual([]);
  }, 60_000);
});
