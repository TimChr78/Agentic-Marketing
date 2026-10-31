import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@agentic-marketing/core';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LOCK_KEY = 7_340_001; // arbitrary constant: one migrator at a time across pods

const roleName = /^[a-z_][a-z0-9_]{0,62}$/;

/** Migration files in apply order. Also used by backups to compare their schema head. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
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

/**
 * Create or update the app role. Migrations and a restore both need it: the GRANTs in the
 * migrations and in a dump name it, and it must exist before they run.
 */
export async function ensureAppRole(client: RoleClient, opts: { appRolePassword: string; appRole?: string }): Promise<string> {
  const role = opts.appRole ?? 'am_app';
  if (!roleName.test(role)) throw new Error(`Invalid app role name ${role}`);
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const pwd = client.escapeLiteral(opts.appRolePassword);
  await client.query(
    rowCount ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${pwd}` : `CREATE ROLE ${role} LOGIN PASSWORD ${pwd} NOSUPERUSER NOBYPASSRLS`,
  );
  return role;
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

/**
 * Apply pending SQL migrations in order, each in its own transaction. Safe to run from several
 * processes at once (advisory lock). Refuses to continue if an applied file was edited.
 *
 * The migrations grant privileges to `am_app`; `appRole` renames it, because roles are shared by
 * every database on a Postgres server (e.g. tests next to a development database).
 */
export async function migrate(admin: pg.Pool, opts: { appRolePassword: string; appRole?: string; log?: (msg: string) => void }) {
  const log = opts.log ?? (() => {});
  const client = await admin.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // The app role is needed by the GRANTs in the migrations.
    const role = await ensureAppRole(client, opts);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of migrationFiles()) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      const checksum = sha256(sql);
      const done = applied.get(file);
      if (done) {
        if (done !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
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
