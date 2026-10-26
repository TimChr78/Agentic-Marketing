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

/**
 * The app role's highest applied migration, or null when the database was never migrated.
 * `to_regclass` is checked first so a backup of a fresh database still works.
 */
export async function migrationHead(databaseUrl: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return null;
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return rows[0]?.version ?? null;
  } finally {
    await client.end();
  }
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
