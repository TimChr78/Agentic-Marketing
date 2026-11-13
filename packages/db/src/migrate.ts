import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@agentic-marketing/core';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LOCK_KEY = 7_340_001; // arbitrary constant: one migrator at a time across pods

const roleName = /^[a-z_][a-z0-9_]{0,62}$/;

/** A migration file whose first line is this marker runs outside BEGIN/COMMIT, statement by statement. */
export const NO_TRANSACTION_MARKER = '-- am:no-transaction';

/** Migration files in apply order. Also used by backups to compare their schema head. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** The newest migration this build knows; a backup from a newer build names a higher one. */
export function latestMigration(): string | undefined {
  return migrationFiles().at(-1);
}

/** One short-lived admin connection for the read-only helpers below. */
async function withPgClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The app role's highest applied migration, or null when the database was never migrated.
 * `to_regclass` is checked first so a backup of a fresh database still works.
 */
export function migrationHead(databaseUrl: string): Promise<string | null> {
  return withPgClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return null;
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return rows[0]?.version ?? null;
  });
}

/** Every workspace id, sorted so a ClickHouse export writes its files in a stable order. */
export function listWorkspaceIds(databaseUrl: string): Promise<string[]> {
  return withPgClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.workspaces') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return [];
    const { rows } = await client.query<{ id: string }>('SELECT id::text AS id FROM workspaces ORDER BY id');
    return rows.map((row) => row.id);
  });
}

/**
 * The release each migration head shipped in, newest last. Releases that share a head are a range:
 * the migration itself cannot tell them apart. Only heads are listed; a database in the middle of
 * a release's migrations never ran a published version.
 */
const MIGRATION_RELEASES: Record<string, string> = {
  '0021_connectors.sql': '0.1.0–0.1.1',
  '0022_test_sends.sql': '0.1.2',
  '0025_assets.sql': '0.2.0',
  '0026_consent_segments_recompute.sql': '0.2.1–0.2.2',
  '0027_journey_consent_exits.sql': '0.2.3–0.2.4',
  // From here a database has a server_versions row; the map is for a migrate that ran without the
  // server, and for tests. Keep the newest migration listed (a test checks it).
  '0028_server_versions.sql': '0.2.5',
  '0033_workspace_proposals.sql': '0.2.6',
  '0034_asset_renditions.sql': '0.2.7',
  '0039_journey_wait_until_entry_keys.sql': '0.2.8',
  '0043_alerts.sql': '0.2.9',
  '0044_journey_exit_step_completed.sql': '0.2.10',
  '0045_agents.sql': '0.3.0',
  '0046_erasure_tombstones.sql': '0.3.0',
  '0047_mandates.sql': '0.4.0',
  '0048_ai_call_kind_check.sql': '0.4.0',
  '0049_agent_notifications.sql': '0.4.0',
  '0050_guardian_shadow.sql': '0.5.0',
  '0051_staged_sends.sql': '0.5.0',
  '0052_hosted_agents.sql': '0.5.0',
  '0053_agent_undo.sql': '0.5.0',
  '0054_ai_call_kind_hosted.sql': '0.5.2',
  '0055_agent_notification_deliveries.sql': '0.5.2',
  '0056_learnings.sql': '0.6.0',
  '0057_agent_subscriptions.sql': '0.6.0',
  '0058_content_sources.sql': '0.6.0',
  '0059_content_topics.sql': '0.6.0',
  '0060_enrollment_jobs.sql': '0.6.0',
  '0061_enrollment_job_versions.sql': '0.6.1',
  '0062_agent_action_level.sql': '0.6.1',
  '0063_hosted_triggers.sql': '0.7.0',
  '0064_decision_models.sql': '0.7.0',
  '0065_hosted_memory.sql': '0.7.0',
  '0066_password_reset.sql': '0.7.0',
  '0067_copilot_agents.sql': '0.7.0–0.7.1',
  '0068_warehouse_change_tracking.sql': '0.7.2',
  '0069_merge_preferences_memberships.sql': '0.7.2',
  '0070_edge_cleanup.sql': '0.7.2',
  '0071_hosted_agent_delete.sql': '0.7.3',
  '0072_audience_reconciliation.sql': '0.7.4',
  '0073_ops_reliability.sql': '0.7.4',
  '0074_password_reset_queue.sql': '0.7.5',
  '0075_workspace_domains.sql': '0.8.0',
  '0076_agent_coordination.sql': '0.8.0',
  '0077_oauth_workspace.sql': '0.8.0',
  '0078_experience_rollouts.sql': '0.8.0',
  '0079_workspace_create.sql': '0.8.0',
  '0080_messages_journey_status.sql': '0.9.0',
  '0081_domain_routing_state.sql': '0.10.1',
  '0082_message_sent_at.sql': '0.10.1',
  '0083_rollout_fixes.sql': '0.10.1',
  '0084_agent_indexes.sql': '0.10.1',
  '0085_rollout_notify_state.sql': '0.10.1',
  '0086_message_sent_at_index.sql': '0.10.1',
  '0087_domain_pending_since.sql': '0.14.2',
  '0088_suppressions_delete_grant.sql': '0.14.4',
  '0089_delivery_kind_index.sql': '0.14.6',
  '0090_suppressions_update_grant.sql': '0.14.11',
  '0091_oauth_selection_rls.sql': '0.14.16',
};

export function releaseForMigrationHead(head: string | null): string | null {
  return head ? (MIGRATION_RELEASES[head] ?? null) : null;
}

/**
 * The version the database last ran: the newest server_versions row, else the release whose
 * migration head it has (an upgrade from 0.2.4 or earlier has no server_versions table yet).
 */
export function lastServerVersion(databaseUrl: string, head?: string | null): Promise<string | null> {
  return withPgClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.server_versions') IS NOT NULL AS present");
    if (present.rows[0]?.present) {
      const { rows } = await client.query<{ version: string }>(
        'SELECT version FROM server_versions ORDER BY last_started_at DESC, first_started_at DESC LIMIT 1',
      );
      if (rows[0]?.version) return rows[0].version;
    }
    if (head !== undefined) return releaseForMigrationHead(head);
    const presentMigrations = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    if (!presentMigrations.rows[0]?.present) return null;
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return releaseForMigrationHead(rows[0]?.version ?? null);
  });
}

/** Records this build as running now. first_started_at stays at the first start of this version. */
export async function recordServerVersion(admin: Pick<pg.Pool, 'query'>, version: string): Promise<void> {
  await admin.query(
    `INSERT INTO server_versions (version) VALUES ($1)
     ON CONFLICT (version) DO UPDATE SET last_started_at = now()`,
    [version],
  );
}

type RoleClient = Pick<pg.Client, 'query' | 'escapeLiteral'>;

/** Whether a role currently has the attributes that let it bypass row-level security. */
async function rolePrivileges(client: RoleClient, role: string) {
  const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [role],
  );
  return rows[0];
}

const privilegesOf = (row: { superuser: boolean; bypassrls: boolean } | undefined) =>
  [row?.superuser ? 'SUPERUSER' : '', row?.bypassrls ? 'BYPASSRLS' : ''].filter(Boolean).join(' and ');

/** One role the app role can `SET ROLE` into, and the chain of memberships that gets it there. */
export interface AppRoleReach {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  /** `[app]` for the app role itself, otherwise app → … → role. */
  chain: string[];
}

/** PostgreSQL 16 is where `pg_auth_members.set_option` and the `SET` privilege mode exist. */
const SET_OPTION_VERSION = 160_000;

/**
 * Every role `$1` can `SET ROLE` into, transitively, and the chain that reaches it (0.14.11 rounds
 * 4 and 5). `NOINHERIT` does not stop `SET ROLE`, so a membership is enough to reach a role's
 * attributes: an app role with neither attribute can still become a member that has BYPASSRLS.
 *
 * PostgreSQL 16 can grant a membership `WITH SET FALSE`, which does not allow `SET ROLE` even when
 * `INHERIT TRUE` keeps the role's privileges; such an edge must not make the role count. The
 * decision is `pg_has_role($1, role, 'SET')`, which covers transitivity and respects the option on
 * every edge. The chain is still walked through `pg_auth_members` for the error message, following
 * only `set_option` edges on 16+, where the column exists. Below 16 every membership implies
 * `SET ROLE`, so `MEMBER` is the equivalent privilege mode and the column does not exist.
 *
 * Shared by the migration and `am doctor`'s `postgres.app-role` check (#813).
 */
export function appRoleReachSql(serverVersionNum: number): string {
  const hasSetOption = serverVersionNum >= SET_OPTION_VERSION;
  return `WITH RECURSIVE reach(role, chain) AS (
    SELECT r.oid, ARRAY[r.rolname]::text[]
      FROM pg_roles r
     WHERE r.rolname = $1
    UNION ALL
    SELECT m.roleid, reach.chain || r.rolname
      FROM reach
      JOIN pg_auth_members m ON m.member = reach.role
      JOIN pg_roles r ON r.oid = m.roleid
     WHERE ${hasSetOption ? 'm.set_option' : 'true'}
       AND NOT r.rolname = ANY(reach.chain)
  )
  SELECT DISTINCT ON (r.rolname)
         r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, reach.chain
    FROM reach
    JOIN pg_roles r ON r.oid = reach.role
   WHERE pg_has_role($1::name, r.oid, '${hasSetOption ? 'SET' : 'MEMBER'}')
   ORDER BY r.rolname, cardinality(reach.chain), reach.chain`;
}

/** The server's numeric version, so {@link appRoleReachSql} can pick the right membership columns. */
async function serverVersionNum(client: Pick<pg.Client, 'query'>): Promise<number> {
  const { rows } = await client.query<{ version: number }>("SELECT current_setting('server_version_num')::int AS version");
  return rows[0]?.version ?? 0;
}

/** Runs {@link appRoleReachSql}; the role itself is one of the rows, with a one-role chain. */
export async function appRoleReach(client: Pick<pg.Client, 'query'>, role: string): Promise<AppRoleReach[]> {
  const { rows } = await client.query<AppRoleReach>(appRoleReachSql(await serverVersionNum(client)), [role]);
  return rows;
}

/**
 * Why the app role may bypass row-level security, or undefined when it may not (0.14.11 round 4).
 * Its own attributes are the first case; a role it can `SET ROLE` into is the second, and the
 * message names the membership chain and the `REVOKE` that removes it.
 */
export async function appRolePrivilegeProblem(client: Pick<pg.Client, 'query'>, role: string): Promise<string | undefined> {
  const reach = await appRoleReach(client, role);
  const self = reach.find((r) => r.role === role);
  if (self?.superuser || self?.bypassrls)
    return (
      `The app role “${role}” still has ${privilegesOf(self)}; row-level security would be bypassed. ` +
      `Run "ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS" as a superuser, or set APP_DB_ROLE to an unprivileged role, then run the migration again.`
    );
  const reached = reach.filter((r) => r.role !== role && (r.superuser || r.bypassrls));
  if (!reached.length) return undefined;
  const list = reached.map((r) => `“${r.role}” (${privilegesOf(r)}) via ${r.chain.join(' → ')}`).join('; ');
  const fix = reached.map((r) => `"REVOKE ${r.role} FROM ${role}"`).join(' ');
  return (
    `The app role “${role}” can SET ROLE to the privileged role ${list}, so row-level security would be bypassed. ` +
    `NOINHERIT does not prevent this: a session can always SET ROLE to a role it is a member of. ` +
    `Fix it as a superuser with ${fix} (or take the role out of that membership chain), or set APP_DB_ROLE to a dedicated unprivileged role, then run the migration again.`
  );
}

/** Postgres refuses to change these attributes of a role the migration user does not administer. */
const isPrivilegeDenied = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return (
    e.code === '42501' ||
    /must be superuser|permission denied to alter role|admin option on role|not have CREATEROLE/i.test(e.message ?? '')
  );
};

/**
 * Create or update the app role. Migrations and a restore both need it: the GRANTs in the
 * migrations and in a dump name it, and it must exist before they run.
 *
 * The role must never bypass row-level security (#813), so an existing role is reset too: an
 * operator who pointed APP_DB_ROLE at a privileged role would otherwise run every request with
 * tenant isolation off. Changing a superuser's attributes needs a superuser; when the migration
 * user may not do it, this says so plainly instead of leaving the bypass in place. A membership
 * that reaches a privileged role is refused as well (0.14.11 round 4), because `SET ROLE` ignores
 * `NOINHERIT`; startup runs the migration, so it refuses to start too.
 */
export async function ensureAppRole(client: RoleClient, opts: { appRolePassword: string; appRole?: string }): Promise<string> {
  const role = opts.appRole ?? 'am_app';
  if (!roleName.test(role)) throw new Error(`Invalid app role name ${role}`);
  const pwd = client.escapeLiteral(opts.appRolePassword);
  // Roles are shared by every database on the server, and the migrator's advisory lock is per
  // database: two databases migrating at once (tests, a restore next to a running install) can
  // race on the same role row. Postgres reports that as "tuple concurrently updated" or a
  // duplicate role; both mean another session just wrote the same role, so look again and retry.
  for (let attempt = 1; ; attempt++) {
    const existing = await rolePrivileges(client, role);
    try {
      if (!existing) await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${pwd} NOSUPERUSER NOBYPASSRLS`);
      else {
        // Name SUPERUSER and BYPASSRLS only when they are actually set. PostgreSQL checks the
        // statement, not the value, so a CREATEROLE migration user gets "permission denied to
        // alter role" for NOSUPERUSER even on a role that is already safe — on every start after
        // the first. LOGIN and PASSWORD are the 0.14.10 statement and stay allowed to the user
        // that administers the role (0.14.11 round 4).
        const reset = [existing.rolsuper ? 'NOSUPERUSER' : '', existing.rolbypassrls ? 'NOBYPASSRLS' : ''].filter(Boolean).join(' ');
        await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${pwd}${reset ? ` ${reset}` : ''}`);
      }
    } catch (err) {
      if (existing && (existing.rolsuper || existing.rolbypassrls) && isPrivilegeDenied(err)) {
        throw new Error(
          `The app role “${role}” has ${privilegesOf({ superuser: existing.rolsuper, bypassrls: existing.rolbypassrls })}, so row-level security would be bypassed, and the migration user may not reset it: ` +
            `${(err as { message?: string }).message ?? String(err)}. Fix it as a superuser with "ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS", ` +
            'or set APP_DB_ROLE to a dedicated unprivileged role, then run the migration again.',
        );
      }
      const e = err as { code?: string; message?: string };
      const raced = e.code === '23505' || e.code === '42710' || /tuple concurrently updated/.test(e.message ?? '');
      if (!raced || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
      continue;
    }
    // Read the attributes and the membership chains back: another session could have granted a
    // privileged role mid-migration, and a superuser must never reach the running app.
    const problem = await appRolePrivilegeProblem(client, role);
    if (problem) throw new Error(problem);
    return role;
  }
}

/** Ensures the role in the database behind `databaseUrl`; a restore runs this before pg_restore. */
export async function ensureAppRoleInDatabase(
  databaseUrl: string,
  opts: { appRolePassword?: string; appRole?: string },
): Promise<{ role: string; created: boolean; exists: boolean }> {
  const role = opts.appRole ?? 'am_app';
  if (!roleName.test(role)) throw new Error(`Invalid app role name ${role}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (opts.appRolePassword) {
      await ensureAppRole(client, { appRolePassword: opts.appRolePassword, appRole: role });
      return { role, created: !rowCount, exists: true };
    }
    return { role, created: false, exists: Boolean(rowCount) };
  } finally {
    await client.end();
  }
}

/** True when a file opts out of the per-migration transaction with its first line. */
export function isNoTransaction(sql: string): boolean {
  return sql
    .replace(/^\uFEFF/, '')
    .trimStart()
    .startsWith(NO_TRANSACTION_MARKER);
}

/** True when a chunk is only whitespace and SQL comments, so it has nothing to execute. */
function isCommentOnly(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c as string)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** The dollar-quote tag at `i` (`$$` or `$name$`), or null for a positional parameter such as `$1`. */
function dollarTagAt(sql: string, i: number): string | null {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0] ?? null;
}

/**
 * Split a migration file into statements without being fooled by semicolons inside strings,
 * quoted identifiers, dollar-quoted function bodies or comments. A no-transaction migration runs
 * each statement on its own, because Postgres wraps a multi-statement query string in one implicit
 * transaction — the thing `CREATE INDEX CONCURRENTLY` refuses.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'") {
      // An E'...' string uses backslash escapes; a plain string does not (standard_conforming_strings).
      const before = i > 0 ? sql[i - 1] : '';
      const backslashEscapes = (before === 'E' || before === 'e') && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2] as string));
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement && !isCommentOnly(statement)) statements.push(statement);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail && !isCommentOnly(tail)) statements.push(tail);
  return statements;
}

const CONCURRENT_INDEX_NAME =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/gi;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Names of the indexes a file builds with CREATE INDEX CONCURRENTLY, for invalid-index recovery. */
export function concurrentIndexNames(sql: string): string[] {
  return [...sql.matchAll(CONCURRENT_INDEX_NAME)].map((match) =>
    (match[1] as string).startsWith('"') ? (match[1] as string).slice(1, -1).replace(/""/g, '"') : (match[1] as string),
  );
}

/**
 * Drop only indexes that Postgres marked INVALID. An interrupted CREATE INDEX CONCURRENTLY leaves
 * one behind; `IF NOT EXISTS` would otherwise skip rebuilding it forever.
 */
async function dropInvalidIndexes(client: Pick<pg.Client, 'query'>, names: string[]): Promise<void> {
  if (!names.length) return;
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND c.relname = ANY($1::text[])`,
    [names],
  );
  for (const { name } of rows) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`);
}

/**
 * Run a no-transaction migration one statement at a time, so each commits on its own and
 * `CREATE INDEX CONCURRENTLY` works. The file must be written to survive a retry: every statement
 * is idempotent. Before the build, an index left INVALID by an earlier attempt is dropped; after a
 * failure the same cleanup runs so the next start is not stuck on `IF NOT EXISTS`.
 */
async function applyNoTransaction(client: Pick<pg.Client, 'query'>, sql: string, role: string): Promise<void> {
  const indexes = concurrentIndexNames(sql);
  await dropInvalidIndexes(client, indexes);
  try {
    for (const statement of splitSqlStatements(sql)) {
      await client.query(role === 'am_app' ? statement : statement.replace(/\bam_app\b/g, role));
    }
  } catch (err) {
    await dropInvalidIndexes(client, indexes).catch(() => {});
    throw err;
  }
}

/** How long to wait between attempts at the migration lock, and in total. */
const LOCK_RETRY_MS = 250;
const LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Take the session-scoped migration lock without ever leaving a statement waiting.
 *
 * A blocking `SELECT pg_advisory_lock` is a statement with a live snapshot. While it waits, the
 * other instance's `CREATE INDEX CONCURRENTLY` waits for that snapshot to end before it can mark
 * the index valid — and the waiting statement waits for the lock that build holds. The two never
 * resolve. Short `pg_try_advisory_lock` calls, with the wait in Node between them, let the index
 * build finish; each attempt commits before the next one, so no old snapshot is left behind.
 */
async function acquireMigrationLock(client: Pick<pg.Client, 'query'>, log: (msg: string) => void): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let waiting = false;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Could not acquire the migration lock within ${Math.round(LOCK_TIMEOUT_MS / 1000)} s: another instance is still migrating or an interrupted migration left the lock held. Check the other instance, then restart this one.`,
      );
    if (!waiting) {
      log('waiting for the migration lock held by another instance…');
      waiting = true;
    }
    // The sleep stays in Node, outside any database statement: a waiting statement would hold a
    // snapshot and keep the concurrent index build from finishing.
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

export interface MigrateOptions {
  appRolePassword: string;
  appRole?: string;
  log?: (msg: string) => void;
  /** Directory of SQL files; tests point this at a temporary directory instead of the checkout. */
  dir?: string;
  /** Apply files up to and including this name, for tests that reconstruct an older schema. */
  upTo?: string;
}

/**
 * Apply pending SQL migrations in order. A normal file runs in one transaction; a file whose first
 * line is `-- am:no-transaction` runs outside one, statement by statement, for `CREATE INDEX
 * CONCURRENTLY`. Safe to run from several processes at once: the session lock is taken with
 * `pg_try_advisory_lock` in a loop so a waiting instance never holds a snapshot that would stall
 * the other instance's concurrent index build. Refuses to continue if
 * an applied file was edited. A no-transaction file is recorded only after every statement succeeds.
 *
 * The migrations grant privileges to `am_app`; `appRole` renames it, because roles are shared by
 * every database on a Postgres server (e.g. tests next to a development database).
 */
export async function migrate(admin: pg.Pool, opts: MigrateOptions) {
  const log = opts.log ?? (() => {});
  const client = await admin.connect();
  try {
    await acquireMigrationLock(client, log);
    // The app role is needed by the GRANTs in the migrations.
    const role = await ensureAppRole(client, opts);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of migrationFiles(opts.dir).filter((name) => !opts.upTo || name <= opts.upTo)) {
      const sql = readFileSync(`${opts.dir ?? MIGRATIONS_DIR}/${file}`, 'utf8');
      const checksum = sha256(sql);
      const done = applied.get(file);
      if (done) {
        if (done !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      if (isNoTransaction(sql)) {
        try {
          await applyNoTransaction(client, sql, role);
        } catch (err) {
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
        // Recorded only now: a failure above leaves the file pending, and its statements idempotent.
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        log(`applied ${file} (no transaction)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(role === 'am_app' ? sql : sql.replace(/\bam_app\b/g, role));
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
