import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@agentic-marketing/core';
import type pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LOCK_KEY = 7_340_001; // arbitrary constant: one migrator at a time across pods

/**
 * Apply pending SQL migrations in order, each in its own transaction. Safe to run from several
 * processes at once (advisory lock). Refuses to continue if an applied file was edited.
 */
export async function migrate(admin: pg.Pool, opts: { appRolePassword: string; log?: (msg: string) => void }) {
  const log = opts.log ?? (() => {});
  const client = await admin.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // The app role is needed by the GRANTs in the migrations.
    const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'am_app'`);
    const pwd = client.escapeLiteral(opts.appRolePassword);
    await client.query(
      rowCount ? `ALTER ROLE am_app WITH LOGIN PASSWORD ${pwd}` : `CREATE ROLE am_app LOGIN PASSWORD ${pwd} NOSUPERUSER NOBYPASSRLS`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      const checksum = sha256(sql);
      const done = applied.get(file);
      if (done) {
        if (done !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
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
