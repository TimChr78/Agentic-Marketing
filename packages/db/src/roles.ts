import type pg from 'pg';

// The server's admin pool (`DATABASE_URL`) reads tenant tables without an `app.workspace_id`; the
// application role (`am_app`) owns none of them. PostgreSQL exempts a table's owner from a row
// policy unless the table is `FORCE ROW LEVEL SECURITY`, which every tenant table here is, so the
// admin role has to be `SUPERUSER` or have `BYPASSRLS` to see every workspace (#1235).
//
// These helpers state and check that requirement once. The restore reads (packages/db/src/erasures.ts)
// use the same catalog view to lift FORCE for an owner that may not bypass; commands that cannot
// lift it refuse instead of reading zero rows and reporting success (#1228, #1229).

/** Anything that can run a query: a `pg.Client`, a `pg.Pool`, or a pool from `createDb`. */
export type RoleQuery = Pick<pg.Client, 'query'>;

export interface TableRls {
  name: string;
  rls: boolean;
  forced: boolean;
  is_owner: boolean;
  bypass: boolean;
  role: string;
}

/**
 * The row-level-security state of `tables` as it applies to this connection's role.
 */
export async function tableRls(client: RoleQuery, tables: readonly string[]): Promise<TableRls[]> {
  const { rows } = await client.query<TableRls>(
    `SELECT c.relname AS name,
            c.relrowsecurity AS rls,
            c.relforcerowsecurity AS forced,
            current_user = pg_get_userbyid(c.relowner) AS is_owner,
            (r.rolsuper OR r.rolbypassrls) AS bypass,
            current_user::text AS role
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  return rows;
}

/**
 * The role neither owns a table nor bypasses RLS, so the tenant policy filters its reads to no
 * rows. Callers use this instead of treating an empty result as "there was nothing".
 */
export class RowsHiddenByRlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowsHiddenByRlsError';
  }
}

/**
 * Refuses a role that is neither a table's owner nor able to bypass RLS.
 *
 * The tenant policy filters that role's reads, so it would read the table as empty and the caller
 * would skip rows it must see — quietly reporting success over data it never saw.
 */
export function assertReadsEveryRow(tables: TableRls[], what: string, consequence: string): void {
  const hidden = tables.find((row) => row.rls && !row.bypass && !row.is_owner);
  if (hidden)
    throw new RowsHiddenByRlsError(
      `${what} is hidden by row-level security from role ${hidden.role}: it is not the owner of ${hidden.name} and ` +
        `does not have BYPASSRLS, so ${consequence}. ` +
        'Run it as the table owner or a role with BYPASSRLS.',
    );
}

/** The tables whose FORCE RLS the owner must lift to read every row (none for a role that bypasses it). */
export function forcedLiftTargets(tables: TableRls[]): string[] {
  return tables.filter((row) => row.forced && row.is_owner && !row.bypass).map((row) => row.name);
}

/** Runs `read` with FORCE lifted on `tables` for one transaction, so a rollback restores it. */
export async function withForcedLift<T>(client: RoleQuery, tables: readonly string[], read: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    for (const table of tables) await client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
    const value = await read();
    for (const table of tables) await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Every workspace id, sorted. `workspaces` is under FORCE RLS, so a table owner that does not
 * bypass RLS reads zero rows with a plain SELECT: lift FORCE for the read, or refuse the role that
 * can see neither (#1220).
 *
 * The catalog is checked before the read, never after: with `app.workspace_id` set, a plain SELECT
 * on an owner connection returns one workspace's rows and looks like a complete answer. Reading
 * inside the lift — when there is one — is the only way to see every workspace.
 */
export async function readAllWorkspaceIds(client: RoleQuery): Promise<string[]> {
  const read = async () =>
    (await client.query<{ id: string }>('SELECT id::text AS id FROM workspaces ORDER BY id')).rows.map((row) => row.id);
  const tables = await tableRls(client, ['workspaces']);
  // A database older than 0.3.0 has no workspaces table, and then there is nothing to read.
  if (!tables.length) return [];
  assertReadsEveryRow(tables, 'the workspace list', 'workspace data would be skipped');
  const lift = forcedLiftTargets(tables);
  return lift.length ? withForcedLift(client, lift, read) : read();
}

/** The current role's attributes and the FORCE-RLS tables it owns. */
export interface AdminRoleStatus {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  /** Every `FORCE ROW LEVEL SECURITY` table in `public` (empty before the first migration). */
  forcedTables: string[];
  /** The subset of {@link forcedTables} this role owns. */
  ownedForcedTables: string[];
}

/** Reads the current role and the FORCE-RLS tables under `public`. */
export async function adminRoleStatus(client: RoleQuery): Promise<AdminRoleStatus> {
  const { rows } = await client.query<{ role: string; superuser: boolean; bypassrls: boolean }>(
    `SELECT current_user::text AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = rows[0] ?? { role: 'unknown', superuser: false, bypassrls: false };
  const tables = await client.query<{ name: string; is_owner: boolean }>(
    `SELECT c.relname AS name, current_user = pg_get_userbyid(c.relowner) AS is_owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relrowsecurity AND c.relforcerowsecurity
      ORDER BY c.relname`,
  );
  return {
    ...role,
    forcedTables: tables.rows.map((row) => row.name),
    ownedForcedTables: tables.rows.filter((row) => row.is_owner).map((row) => row.name),
  };
}

/**
 * Why the admin role cannot read every tenant row, or undefined when it can (#1235).
 *
 * A superuser or a `BYPASSRLS` role passes. Below the first migration there are no tenant tables
 * yet, so nothing can be hidden. Any other role would read zero rows from every `FORCE ROW LEVEL
 * SECURITY` table the admin pool uses (sessions, API tokens, workspaces, background loops).
 */
export function adminRoleProblem(status: AdminRoleStatus, what = 'The server'): string | undefined {
  if (status.superuser || status.bypassrls) return undefined;
  if (!status.forcedTables.length) return undefined;
  const owns = status.ownedForcedTables.length > 0;
  const ownership = owns
    ? `owns ${status.ownedForcedTables.length} row-level-security table(s) (including ${status.ownedForcedTables[0]}) but`
    : `is subject to FORCE ROW LEVEL SECURITY on ${status.forcedTables.length} table(s) (including ${status.forcedTables[0]}) and`;
  return (
    `The database role "${status.role}" that DATABASE_URL names ${ownership} is not SUPERUSER and does not have BYPASSRLS. ` +
    `${what} reads tenant rows on the admin pool without app.workspace_id, so it would see none: sign-in, API tokens and background work would fail. ` +
    `As a superuser run "ALTER ROLE ${status.role} BYPASSRLS" (or point DATABASE_URL at a role that is SUPERUSER or has BYPASSRLS).`
  );
}

/**
 * Why the admin role lacks the attributes, regardless of what tables exist yet (#1218 review).
 *
 * Startup enforces this even on an empty database: `SKIP_MIGRATIONS=true` used to exempt a role
 * that owns no FORCE-RLS table, so the process started and only failed later, once the schema
 * existed, with the misleading symptoms the strict check exists to prevent.
 */
export function adminRoleBypassProblem(status: AdminRoleStatus, what = 'The server'): string | undefined {
  if (status.superuser || status.bypassrls) return undefined;
  return (
    `The database role "${status.role}" that DATABASE_URL names is not SUPERUSER and does not have BYPASSRLS. ` +
    `${what} reads tenant rows on the admin pool without app.workspace_id, so it would see none. ` +
    `As a superuser run "ALTER ROLE ${status.role} BYPASSRLS" (or point DATABASE_URL at a role that is SUPERUSER or has BYPASSRLS).`
  );
}

/**
 * Refuses a role that is not SUPERUSER and does not have BYPASSRLS, whatever it owns.
 *
 * `pg_dump` reads with `row_security = off` and PostgreSQL refuses that for a FORCE-RLS table even
 * when the role owns it, so a backup needs the attribute, not merely ownership (#1218 review).
 * `am migrate` and `am restore` still work as the owner: they lift FORCE for the rows they read.
 */
export async function assertBypassesRls(client: RoleQuery, what = 'This command'): Promise<void> {
  const problem = adminRoleBypassProblem(await adminRoleStatus(client), what);
  if (problem) throw new Error(problem);
}

/**
 * Refuses a role that cannot see every tenant row. The server checks this at startup and
 * `am doctor` reports it as `postgres.admin-role`; commands that write or rotate rows across
 * workspaces call it before they do anything, so they never report success over invisible data.
 *
 * The attribute check runs first and does not depend on the schema: a role that cannot bypass may
 * own nothing yet, and would still fail once the migrations create the FORCE-RLS tables.
 */
export async function assertAdminRoleReadsEveryRow(client: RoleQuery, what = 'The server'): Promise<void> {
  await assertBypassesRls(client, what);
}
