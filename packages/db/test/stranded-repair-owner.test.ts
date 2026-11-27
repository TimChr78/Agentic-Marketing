import { randomBytes } from 'node:crypto';
import { newId } from '@agentic-marketing/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrate';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #1218: 0117, 0118 and 0119 loop over `SELECT id FROM workspaces` to set `app.workspace_id`.
// `workspaces` is FORCE ROW LEVEL SECURITY, so a non-superuser table owner without BYPASSRLS —
// the small-install migrator AGENTS.md describes — read no workspace, did nothing, and the files
// were recorded as applied. 0122 repeats the three repairs with FORCE briefly lifted.

vi.setConfig({ hookTimeout: 180_000 });

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const roles: string[] = [];

const survivor = newId('prf');
const strandedList = newId('prf');
const strandedScore = newId('prf');
const list = newId('seg');
const delivery = newId('dlv');
const deliveryColon = newId('dlv');

type Disposable = Awaited<ReturnType<typeof createDisposableDb>>;

/** Seeds the three kinds of stranded rows into a database stopped before 0117. */
async function seedStranded(db: Disposable): Promise<void> {
  await db.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
       ($1, $2, NULL),
       ($1, $3, $2),
       ($1, $4, $2)`,
    [db.workspace, survivor, strandedList, strandedScore],
  );
  await db.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'segment', 'Stranded', 1, 1)`,
    [db.workspace, list],
  );
  await db.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, 'hash-0121', 'user', 'test')`,
    [db.workspace, list, JSON.stringify({ description: '', mode: 'static' })],
  );
  // #1102: a static-list row left on a merged-away profile.
  await db.db.admin.query(
    `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, added_at, added_by, source)
     VALUES ($1, $2, $3, now(), 'usr_old', 'csv')`,
    [db.workspace, list, strandedList],
  );
  // #1144: a score left on another merged-away profile.
  await db.db.admin.query(
    `INSERT INTO profile_scores (workspace_id, profile_id, key, value, model, model_version, created_at, expires_at)
     VALUES ($1, $2, 'churn', 0.8, 'test-model', 'v1', now(), '2030-01-01T00:00:00Z')`,
    [db.workspace, strandedScore],
  );
  // #1155: ad-conversion deliveries queued under the pre-0.17.6 idempotency key. The second row's
  // old key (`adc:meta:conn_0121:purchase:msg_0121`) is exactly the first row's new key, so a
  // rewrite that only compares keys deletes the `msg_0121` delivery as a duplicate.
  await db.db.admin.query(
    `INSERT INTO deliveries (workspace_id, id, kind, target_id, action, payload, status, idempotency_key)
     VALUES ($1, $2, 'ad_conversion', 'conn_0121', 'meta',
             '{"eventId":"msg_0121","destination":{"conversionAction":"purchase"}}'::jsonb,
             'pending', 'adc:meta:conn_0121:msg_0121'),
            ($1, $3, 'ad_conversion', 'conn_0121', 'meta',
             '{"eventId":"purchase:msg_0121","destination":{"conversionAction":"purchase"}}'::jsonb,
             'pending', 'adc:meta:conn_0121:purchase:msg_0121')`,
    [db.workspace, delivery, deliveryColon],
  );
}

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  // Up to the head before 0117, so every stranded row exists when the repairs run.
  d = await createDisposableDb('stranded_owner', { upTo: '0116_broadcast_test_decision_variants.sql' });
  await seedStranded(d);
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

/**
 * A login role that owns every table, sequence and the 0069 repair function in `db`, without
 * BYPASSRLS. A small install's role ran every earlier migration, so 0122 can execute the repairs;
 * a role without EXECUTE would fail loudly instead of silently.
 */
async function ownEverything(db: Disposable, role: string): Promise<pg.Pool> {
  await db.db.admin.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
  await db.db.admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
  const tables = await db.db.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const { tablename } of tables.rows) await db.db.admin.query(`ALTER TABLE "public"."${tablename}" OWNER TO ${role}`);
  const sequences = await db.db.admin.query<{ sequencename: string }>("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'");
  for (const { sequencename } of sequences.rows) await db.db.admin.query(`ALTER SEQUENCE "public"."${sequencename}" OWNER TO ${role}`);
  await db.db.admin.query(`ALTER FUNCTION merge_segment_memberships(text, text) OWNER TO ${role}`);
  const url = new URL(db.url.toString());
  url.username = role;
  url.password = 'rls-password';
  return new pg.Pool({ connectionString: url.toString() });
}

describe.skipIf(!hasTestDatabase())('the 0117–0119 repairs under a non-BYPASSRLS owner (#1218)', () => {
  it('repairs the stranded list row, score and conversion key when the migration role owns the tables', async () => {
    const suffix = randomBytes(4).toString('hex');
    const role = `am_stranded_mig_${suffix}`;
    const appRole = `am_stranded_app_${suffix}`;
    roles.push(role, appRole);
    const limited = await ownEverything(d, role);
    try {
      // The premise: the migration role reads no workspace without `app.workspace_id`.
      expect((await limited.query<{ n: number }>('SELECT count(*)::int AS n FROM workspaces')).rows[0]?.n).toBe(0);
      await migrate(limited, { appRole, appRolePassword: 'rls-app-password' });
    } finally {
      await limited.end();
    }

    // Those files are recorded as applied, so only 0122 can have repaired the rows.
    const applied = await d.db.admin.query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version IN ('0117_stranded_segment_memberships.sql', '0118_ad_conversion_idempotency_keys.sql',
                          '0119_stranded_profile_scores.sql', '0122_replay_owner_repairs.sql')
        ORDER BY version`,
    );
    expect(applied.rows.map((row) => row.version)).toEqual([
      '0117_stranded_segment_memberships.sql',
      '0118_ad_conversion_idempotency_keys.sql',
      '0119_stranded_profile_scores.sql',
      '0122_replay_owner_repairs.sql',
    ]);

    const listRows = await d.db.admin.query<{ profile_id: string }>(
      'SELECT profile_id FROM segment_list_members WHERE workspace_id = $1 AND segment_id = $2',
      [d.workspace, list],
    );
    expect(listRows.rows.map((row) => row.profile_id)).toEqual([survivor]);

    const scores = await d.db.admin.query<{ profile_id: string }>('SELECT profile_id FROM profile_scores WHERE workspace_id = $1', [
      d.workspace,
    ]);
    expect(scores.rows.map((row) => row.profile_id)).toEqual([survivor]);

    const keys = await d.db.admin.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM deliveries WHERE workspace_id = $1 ORDER BY idempotency_key',
      [d.workspace],
    );
    expect(keys.rows.map((row) => row.idempotency_key)).toEqual([
      'adc:meta:conn_0121:purchase:msg_0121',
      'adc:meta:conn_0121:purchase:purchase:msg_0121',
    ]);
    expect(keys.rowCount).toBe(2);
  }, 180_000);
});

describe.skipIf(!hasTestDatabase())('the 0122 replay for a migrator that bypasses RLS (#1218 review)', () => {
  it('repairs rows stranded by an earlier non-bypass run when a superuser applies 0122', async () => {
    // The scenario the replay exists for: 0117–0119 ran as a non-bypass owner (they read no
    // workspace and recorded themselves), then the operator granted BYPASSRLS before upgrading,
    // which is what the 0.17.8 breaking-change note asks. 0122 now runs for the bypassing migrator
    // too, so the stranded rows are repaired instead of skipped forever.
    const fresh = await createDisposableDb('stranded_bypass', { upTo: '0116_broadcast_test_decision_variants.sql' });
    const suffix = randomBytes(4).toString('hex');
    const role = `am_stranded_bypass_mig_${suffix}`;
    const appRole = `am_stranded_bypass_app_${suffix}`;
    roles.push(role, appRole);
    try {
      await seedStranded(fresh);
      const limited = await ownEverything(fresh, role);
      try {
        await migrate(limited, { appRole, appRolePassword: 'rls-app-password', upTo: '0121_journey_participant_attempts.sql' });
      } finally {
        await limited.end();
      }

      // The premise: 0117–0119 were applied but changed nothing on this install.
      const appliedBefore = await fresh.db.admin.query<{ version: string }>(
        `SELECT version FROM schema_migrations
          WHERE version IN ('0117_stranded_segment_memberships.sql', '0118_ad_conversion_idempotency_keys.sql',
                            '0119_stranded_profile_scores.sql', '0122_replay_owner_repairs.sql')
          ORDER BY version`,
      );
      expect(appliedBefore.rows.map((row) => row.version)).toEqual([
        '0117_stranded_segment_memberships.sql',
        '0118_ad_conversion_idempotency_keys.sql',
        '0119_stranded_profile_scores.sql',
      ]);
      const listBefore = await fresh.db.admin.query<{ profile_id: string }>(
        'SELECT profile_id FROM segment_list_members WHERE workspace_id = $1 AND segment_id = $2',
        [fresh.workspace, list],
      );
      expect(listBefore.rows.map((row) => row.profile_id)).toEqual([strandedList]);
      const scoresBefore = await fresh.db.admin.query<{ profile_id: string }>(
        'SELECT profile_id FROM profile_scores WHERE workspace_id = $1',
        [fresh.workspace],
      );
      expect(scoresBefore.rows.map((row) => row.profile_id)).toEqual([strandedScore]);
      const keysBefore = await fresh.db.admin.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM deliveries WHERE workspace_id = $1 ORDER BY idempotency_key',
        [fresh.workspace],
      );
      expect(keysBefore.rows.map((row) => row.idempotency_key)).toEqual([
        'adc:meta:conn_0121:msg_0121',
        'adc:meta:conn_0121:purchase:msg_0121',
      ]);

      // The superuser the tests run as bypasses RLS and applies 0122 alone.
      await migrate(fresh.db.admin, { appRole, appRolePassword: 'rls-app-password' });

      const listAfter = await fresh.db.admin.query<{ profile_id: string }>(
        'SELECT profile_id FROM segment_list_members WHERE workspace_id = $1 AND segment_id = $2',
        [fresh.workspace, list],
      );
      expect(listAfter.rows.map((row) => row.profile_id)).toEqual([survivor]);
      const scoresAfter = await fresh.db.admin.query<{ profile_id: string }>(
        'SELECT profile_id FROM profile_scores WHERE workspace_id = $1',
        [fresh.workspace],
      );
      expect(scoresAfter.rows.map((row) => row.profile_id)).toEqual([survivor]);
      const keysAfter = await fresh.db.admin.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM deliveries WHERE workspace_id = $1 ORDER BY idempotency_key',
        [fresh.workspace],
      );
      expect(keysAfter.rows.map((row) => row.idempotency_key)).toEqual([
        'adc:meta:conn_0121:purchase:msg_0121',
        'adc:meta:conn_0121:purchase:purchase:msg_0121',
      ]);
    } finally {
      await fresh.close().catch(() => {});
    }
  }, 180_000);
});
