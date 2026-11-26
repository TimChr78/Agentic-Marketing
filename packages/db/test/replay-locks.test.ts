import { randomBytes } from 'node:crypto';
import { newId } from '@agentic-marketing/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrate';
import { createDisposableDb, hasTestDatabase } from './disposable';

// The 0122 replay must not invert the lock order live ingestion uses: an ingest transaction takes
// the workspace's identity advisory lock first and then needs `workspaces` through a foreign key.
// A migration that holds the `workspaces` ACCESS EXCLUSIVE lock (the FORCE lift) while waiting for
// that identity lock produces a 40P01 deadlock. A SUPERUSER or BYPASSRLS migrator already ran the
// 0117–0119 repairs, so 0122 must take no lock at all for it.

vi.setConfig({ hookTimeout: 180_000, testTimeout: 120_000 });

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const roles: string[] = [];

const survivor = newId('prf');
const stranded = newId('prf');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('replay_locks', { upTo: '0116_broadcast_test_decision_variants.sql' });
  const ws = d.workspace;
  await d.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
       ($1, $2, NULL),
       ($1, $3, $2)`,
    [ws, survivor, stranded],
  );
  await d.db.admin.query(
    `INSERT INTO profile_scores (workspace_id, profile_id, key, value, model, model_version, created_at, expires_at)
     VALUES ($1, $2, 'churn', 0.8, 'test-model', 'v1', now(), '2030-01-01T00:00:00Z')`,
    [ws, stranded],
  );
}, 120_000);

afterAll(async () => {
  await d?.close().catch(() => {});
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

/** A login role that owns every table and sequence, without BYPASSRLS. */
async function ownEverything() {
  const role = `am_replay_lock_${randomBytes(4).toString('hex')}`;
  roles.push(role);
  await d.db.admin.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
  await d.db.admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
  const tables = await d.db.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const { tablename } of tables.rows) await d.db.admin.query(`ALTER TABLE "public"."${tablename}" OWNER TO ${role}`);
  const sequences = await d.db.admin.query<{ sequencename: string }>("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'");
  for (const { sequencename } of sequences.rows) await d.db.admin.query(`ALTER SEQUENCE "public"."${sequencename}" OWNER TO ${role}`);
  await d.db.admin.query(`ALTER FUNCTION merge_segment_memberships(text, text) OWNER TO ${role}`);
  const url = new URL(d.url.toString());
  url.username = role;
  url.password = 'rls-password';
  return { role, url: url.toString() };
}

const ownerPool = (url: string) => new pg.Pool({ connectionString: url });

describe.skipIf(!hasTestDatabase())('the 0122 replay lock order (#1218 review)', () => {
  it('takes the identity lock before the FORCE lift, so live ingestion does not deadlock', async () => {
    const owner = await ownEverything();
    const appRole = `am_replay_app_${randomBytes(4).toString('hex')}`;
    roles.push(appRole);
    const limited = ownerPool(owner.url);
    const ingest = new pg.Client({ connectionString: d.url.toString() });
    await ingest.connect();
    try {
      await ingest.query('BEGIN');
      await ingest.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`identity:${d.workspace}`]);

      const migration = migrate(limited, { appRole, appRolePassword: 'rls-app-password' });
      // Let the migration reach its lock step. The old order takes `workspaces` first and then waits
      // for the identity lock above.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Ingestion's next statement needs `workspaces` through a foreign key (RowShare). With the
      // old order this blocks behind the migration's ACCESS EXCLUSIVE lock while the migration
      // waits for the identity lock: PostgreSQL reports 40P01 and aborts one of the two.
      await ingest.query('SELECT 1 FROM workspaces WHERE id = $1 FOR KEY SHARE', [d.workspace]);
      await ingest.query('COMMIT');

      await expect(migration).resolves.toBeUndefined();
    } finally {
      await ingest.query('ROLLBACK').catch(() => {});
      await ingest.end().catch(() => {});
      await limited.end().catch(() => {});
    }

    const scores = await d.db.admin.query<{ profile_id: string }>('SELECT profile_id FROM profile_scores WHERE workspace_id = $1', [
      d.workspace,
    ]);
    expect(scores.rows.map((row) => row.profile_id)).toEqual([survivor]);
  }, 120_000);

  it('does nothing, and takes no workspace lock, for a bypassing migrator', async () => {
    // 0122 is still pending because the owner-only test above used its own disposable database.
    const fresh = await createDisposableDb('replay_noop', { upTo: '0116_broadcast_test_decision_variants.sql' });
    const appRole = `am_replay_noop_app_${randomBytes(4).toString('hex')}`;
    roles.push(appRole);
    const blocker = new pg.Client({ connectionString: fresh.url.toString() });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      // Conflicts with the ACCESS EXCLUSIVE lock an `ALTER TABLE workspaces` would take.
      await blocker.query('LOCK TABLE workspaces IN ACCESS SHARE MODE');

      const migration = migrate(fresh.db.admin, { appRole, appRolePassword: 'rls-app-password' });
      const finished = await Promise.race([
        migration.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
      ]);
      expect(finished).toBe(true);
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end().catch(() => {});
      await fresh.close().catch(() => {});
    }
  }, 120_000);
});
