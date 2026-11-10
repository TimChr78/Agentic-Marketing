import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { backfillSentAtOnce } from '../src/backfill';
import { concurrentIndexNames, isNoTransaction, migrate } from '../src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// The 0.10.1 migrations on a populated database (#453, #488, 0.10.1 review). 0.10.0's schema is
// the head before 0082; the messages table is seeded with completed rows, then 0082 to the current
// head run. The test guards the properties that make this safe on a large install:
//   - 0082 is metadata-only and never rewrites the table;
//   - the concurrent index files are marked no-transaction;
//   - a send is not blocked by a ShareLock while the indexes build;
//   - the sent_at backfill is batched, resumable and leaves the cap fallback correct until done;
//   - 0083 still sees pre-upgrade paused ramps under the migration role with FORCE RLS.

const SEEDED = 200_000;
const MIGRATION_DIR = new URL('../migrations/', import.meta.url);

const migration = (name: string) => readFileSync(new URL(name, MIGRATION_DIR), 'utf8');

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTestDatabase())('0.10.1 migrations on a populated install', () => {
  it('adds sent_at without rewriting, builds indexes concurrently, and backfills in batches', async () => {
    const d = await createDisposableDb('sentat', { upTo: '0081_domain_routing_state.sql' });
    open.push(d);
    const ws = d.workspace;
    await d.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, test, created_at, updated_at)
         SELECT $1, 'm_' || g, 'k_' || g, 'email', 'p_' || (g % 1000), 'marketing_email',
                CASE WHEN g % 2 = 0 THEN 'delivered' ELSE 'sent' END, false,
                now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
           FROM generate_series(1, $2) AS g`,
      [ws, SEEDED],
    );

    // A live send path: insert a queued message while the migrations run. A ShareLock from an
    // ordinary CREATE INDEX would hold these inserts until the build finished.
    const probe = new pg.Client({ connectionString: d.url.toString() });
    await probe.connect();
    const sampler = new pg.Client({ connectionString: d.url.toString() });
    await sampler.connect();
    let stop = false;
    let inserts = 0;
    let maxInsertMs = 0;
    let shareLockSamples = 0;
    let exclusiveSamples = 0;
    let probeId = 0;
    const sendLoop = (async () => {
      while (!stop) {
        const started = Date.now();
        await probe.query(
          `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, test)
             VALUES ($1, $2, $2, 'email', 'p_live', 'marketing_email', 'queued', false)`,
          [ws, `live_${probeId++}`],
        );
        maxInsertMs = Math.max(maxInsertMs, Date.now() - started);
        inserts++;
        await delay(10);
      }
    })();
    const lockLoop = (async () => {
      while (!stop) {
        const { rows } = await sampler.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
              WHERE relation = 'messages'::regclass
                AND mode IN ('ShareLock', 'AccessExclusiveLock')
                AND pid <> pg_backend_pid()`,
        );
        for (const row of rows) {
          if (row.mode === 'ShareLock') shareLockSamples++;
          else exclusiveSamples++;
        }
        await delay(5);
      }
    })();

    const applied: string[] = [];
    try {
      await migrate(d.db.admin, { ...APP_ROLE, log: (message) => applied.push(message) });
    } finally {
      stop = true;
      await Promise.all([sendLoop, lockLoop]);
      await probe.end();
      await sampler.end();
    }

    // The file is no longer a rewrite inside one transaction.
    const sentAt = migration('0082_message_sent_at.sql');
    expect(sentAt).not.toMatch(/UPDATE\s+messages/i);
    expect(sentAt).toMatch(/ADD COLUMN sent_at/);
    for (const file of ['0084_agent_indexes.sql', '0086_message_sent_at_index.sql']) {
      const sql = migration(file);
      expect(isNoTransaction(sql), `${file} must be marked no-transaction`).toBe(true);
      for (const name of concurrentIndexNames(sql)) expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}`);
    }
    expect(applied).toContain('applied 0086_message_sent_at_index.sql (no transaction)');

    // CREATE INDEX CONCURRENTLY takes ShareUpdateExclusive, never ShareLock; the only exclusive
    // lock is the instant ADD COLUMN changes the catalog, not a table rewrite.
    expect(shareLockSamples, 'a normal CREATE INDEX would have blocked writes with ShareLock').toBe(0);
    expect(exclusiveSamples, 'ADD COLUMN must release its ACCESS EXCLUSIVE lock immediately').toBeLessThan(40);
    expect(inserts).toBeGreaterThan(0);
    expect(maxInsertMs, `a send waited ${maxInsertMs} ms during the migration`).toBeLessThan(2_000);

    const indexes = await d.db.admin.query<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('messages_policy_window', 'messages_sent_at_pending')`,
    );
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows.every((row) => row.valid)).toBe(true);

    // The migration leaves the rows NULL; the background job fills them in short batches.
    const before = await d.db.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE status IN ('sent','delivered','bounced','complained') AND sent_at IS NOT NULL`,
    );
    expect(Number(before.rows[0]?.count)).toBe(0);

    const first = await backfillSentAtOnce(d.db.admin, { batchSize: 10_000, maxBatches: 2 });
    expect(first.updated).toBe(20_000);
    expect(first.more).toBe(true);
    const rest = await backfillSentAtOnce(d.db.admin, { batchSize: 10_000 });
    expect(first.updated + rest.updated).toBe(SEEDED);
    expect(rest.more).toBe(false);

    const after = await d.db.admin.query<{ missing: string; drifted: string }>(
      `SELECT count(*) FILTER (WHERE sent_at IS NULL)::text AS missing,
                count(*) FILTER (WHERE sent_at IS DISTINCT FROM updated_at)::text AS drifted
           FROM messages WHERE status IN ('sent','delivered','bounced','complained')`,
    );
    expect(after.rows[0]).toEqual({ missing: '0', drifted: '0' });
  }, 180_000);

  it('applies the pause backfill under a non-superuser migration role with FORCE RLS', async () => {
    const d = await createDisposableDb('sentatrls', { upTo: '0081_domain_routing_state.sql' });
    open.push(d);
    const suffix = randomBytes(4).toString('hex');
    const role = `am_rls_mig_${suffix}`;
    const appRole = `am_rls_app_${suffix}`;
    const pausedAt = new Date();
    try {
      await d.db.admin.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
      await d.db.admin.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
      // The migration role owns the tables the migration files alter. It is deliberately not a
      // superuser and has no BYPASSRLS, so FORCE RLS applies to it.
      for (const table of ['messages', 'experience_rollouts', 'hosted_agent_runs', 'workspaces', 'workspace_domains'])
        await d.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
      await d.db.admin.query(`GRANT SELECT, INSERT ON schema_migrations TO ${role}`);
      await d.db.admin.query(
        `INSERT INTO experience_rollouts (workspace_id, artifact_id, version, steps, step_hours, step_index, share, status, paused_at)
           VALUES ($1, 'exp_paused_before_upgrade', 1, '{10,50}', 24, 1, 10, 'paused', $2)`,
        [d.workspace, pausedAt],
      );
      // 0087 backfills pending_since under FORCE RLS. A populated row inserted before it runs proves
      // the backfill sees the row as the non-BYPASSRLS owner, so SET NOT NULL cannot fail.
      const domainCreatedAt = new Date(Date.now() - 60_000);
      await d.db.admin.query(
        `INSERT INTO workspace_domains (id, workspace_id, host, status, verification_token, created_by, created_at)
           VALUES ('dom_before_0087', $1, 'before-0087.example', 'pending', 'token-before-0087', 'test', $2)`,
        [d.workspace, domainCreatedAt],
      );

      const limitedUrl = new URL(d.url.toString());
      limitedUrl.username = role;
      limitedUrl.password = 'rls-password';
      const limited = new pg.Pool({ connectionString: limitedUrl.toString() });
      try {
        await migrate(limited, { appRole, appRolePassword: 'rls-app-password' });
      } finally {
        await limited.end();
      }

      // 0083 read experience_rollouts as its owner with FORCE briefly off; a plain SELECT under
      // the limited role would have seen no rows and lost this pause.
      const { rows } = await d.db.admin.query<{ notified_at: Date | null }>(
        `SELECT notified_at FROM experience_rollout_pauses
            WHERE workspace_id = $1 AND artifact_id = 'exp_paused_before_upgrade'`,
        [d.workspace],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.notified_at).not.toBeNull();

      const domain = await d.db.admin.query<{ pending_since: Date; created_at: Date }>(
        `SELECT pending_since, created_at FROM workspace_domains WHERE id = 'dom_before_0087'`,
      );
      expect(domain.rows, '0087 must not fail on a populated database').toHaveLength(1);
      expect(domain.rows[0]?.pending_since.getTime()).toBe(domain.rows[0]?.created_at.getTime());

      const sentAt = await d.db.admin.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'sent_at') AS present`,
      );
      expect(sentAt.rows[0]?.present).toBe(true);
      const valid = await d.db.admin.query<{ valid: boolean }>(
        `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'messages_policy_window'::regclass`,
      );
      expect(valid.rows[0]?.valid).toBe(true);
    } finally {
      await d.close().catch(() => {});
      const maint = new pg.Client({
        connectionString: Object.assign(new URL(process.env.TEST_DATABASE_URL ?? ''), { pathname: '/postgres' }).toString(),
      });
      await maint.connect();
      try {
        for (const name of [appRole, role]) await maint.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
      } finally {
        await maint.end();
      }
    }
  }, 180_000);
});
