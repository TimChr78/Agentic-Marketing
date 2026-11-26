import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readDataKeySample } from '../src/data-keys';
import { listWorkspaceIds } from '../src/migrate';
import { createDb } from '../src/pool';
import { adminRoleProblem, adminRoleStatus, assertAdminRoleReadsEveryRow } from '../src/roles';
import { createDisposableDb, hasTestDatabase } from './disposable';

// A small-install role owns the tables but is not a superuser and has no BYPASSRLS. Every tenant
// table is FORCE ROW LEVEL SECURITY, so a plain SELECT on it returns no rows. These are the reads
// that must lift FORCE for that role, or refuse it instead of reporting success over nothing:
//   * #1220 `am backup --clickhouse` reads every workspace id;
//   * #1221 the post-restore key check, the backup trial unseal and `am doctor` read `data_keys`;
//   * #1235 the server's admin pool needs a role that bypasses RLS at all.

// Several disposable databases; dropping them under a full parallel run can pass 60 s.
vi.setConfig({ hookTimeout: 180_000 });

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const roles: string[] = [];

afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
  const maint = new pg.Client({
    connectionString: Object.assign(new URL(process.env.TEST_DATABASE_URL ?? ''), { pathname: '/postgres' }).toString(),
  });
  await maint.connect();
  try {
    for (const role of roles) await maint.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  } finally {
    await maint.end();
  }
});

const roleName = (prefix: string) => `am_${prefix}_${randomBytes(4).toString('hex')}`;

/** A login role that owns `tables`, i.e. a small install's table owner without BYPASSRLS. */
async function ownerOf(d: Awaited<ReturnType<typeof createDisposableDb>>, tables: string[]) {
  const role = roleName('owner');
  roles.push(role);
  await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
  for (const table of tables) await d.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
  const url = new URL(d.url.toString());
  url.username = role;
  url.password = 'rls-password';
  return { role, url: url.toString() };
}

/** A login role that neither owns the tables nor may bypass RLS. */
async function outsiderOf(d: Awaited<ReturnType<typeof createDisposableDb>>) {
  const role = roleName('outsider');
  roles.push(role);
  await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
  // Grants without ownership: what a managed-Postgres role often has. RLS still filters it to none.
  await d.db.admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await d.db.admin.query(`GRANT SELECT ON data_keys, workspaces TO ${role}`);
  const url = new URL(d.url.toString());
  url.username = role;
  url.password = 'rls-password';
  return { role, url: url.toString() };
}

describe.skipIf(!hasTestDatabase())('a non-BYPASSRLS table owner and the admin reads', () => {
  it('#1220 listWorkspaceIds sees every workspace as the owner', async () => {
    const d = await createDisposableDb('admin_role_ws');
    open.push(d);
    const owner = await ownerOf(d, ['workspaces']);

    // The premise: a plain SELECT under the owner reads no workspace.
    const direct = new pg.Client({ connectionString: owner.url });
    await direct.connect();
    try {
      expect((await direct.query<{ n: number }>('SELECT count(*)::int AS n FROM workspaces')).rows[0]?.n).toBe(0);
    } finally {
      await direct.end();
    }

    expect(await listWorkspaceIds(owner.url)).toEqual([d.workspace]);
  }, 60_000);

  it('#1221 readDataKeySample sees the sealed key as the owner', async () => {
    const d = await createDisposableDb('admin_role_keys');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_owner_read', 'local-owner-test', $2)`,
      [d.workspace, Buffer.alloc(80, 7)],
    );
    const owner = await ownerOf(d, ['data_keys']);

    const sample = await readDataKeySample(owner.url);
    expect(sample).toEqual({
      id: 'dk_owner_read',
      workspaceId: d.workspace,
      kekId: 'local-owner-test',
      wrappedKey: Buffer.alloc(80, 7),
    });
  }, 60_000);

  it('#1221 refuses a role that can see neither the keys nor the workspace list', async () => {
    const d = await createDisposableDb('admin_role_hidden');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key)
       VALUES ($1, 'dk_hidden', 'local-owner-test', $2)`,
      [d.workspace, Buffer.alloc(80, 7)],
    );
    const outsider = await outsiderOf(d);

    await expect(readDataKeySample(outsider.url)).rejects.toThrow(/BYPASSRLS/);
    await expect(listWorkspaceIds(outsider.url)).rejects.toThrow(/BYPASSRLS/);
  }, 60_000);

  it('#1235 names the role and the ALTER ROLE fix instead of starting on a role that sees nothing', async () => {
    const d = await createDisposableDb('admin_role_start');
    open.push(d);
    const owner = await ownerOf(d, ['workspaces']);
    const ownerDb = createDb({ adminUrl: owner.url, appUrl: owner.url, poolSize: 1 });
    try {
      const status = await adminRoleStatus(ownerDb.admin);
      expect(status).toMatchObject({ role: owner.role, superuser: false, bypassrls: false });
      expect(status.ownedForcedTables).toContain('workspaces');
      const problem = adminRoleProblem(status, 'The server');
      expect(problem).toContain(owner.role);
      expect(problem).toContain('ALTER ROLE');
      expect(problem).toContain('BYPASSRLS');
      await expect(assertAdminRoleReadsEveryRow(ownerDb.admin, 'The server')).rejects.toThrow(/ALTER ROLE/);

      // The superuser running the tests passes.
      await expect(assertAdminRoleReadsEveryRow(d.db.admin, 'The server')).resolves.toBeUndefined();
      expect(adminRoleProblem(await adminRoleStatus(d.db.admin))).toBeUndefined();
    } finally {
      await ownerDb.close();
    }
  }, 60_000);
});
