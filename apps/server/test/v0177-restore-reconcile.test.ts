import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { reconcileRestoredErasureExclusions } from '../src/ops/restore-reconcile';

// The restore's final step (#1194). It must publish only what the ClickHouse point lost, record the
// confirmation on the jobs, and leave a completed job complete instead of reopening every
// historical sweep. These tests use a fake ClickHouse store: the SQL and batching are what matter.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('restore reconciliation of erasure exclusions (#1194)', () => {
  it('re-publishes only missing keys, then marks the jobs published without reopening complete ones', async () => {
    const d = await createDisposableDb('restore_reconcile');
    open.push(d);
    const completeErasure = 'era_00000000000000000000000000000a11';
    const unfinishedErasure = 'era_00000000000000000000000000000b22';
    const keys = [
      { erasureId: completeErasure, key: 'a'.repeat(64) },
      { erasureId: completeErasure, key: 'b'.repeat(64) },
      { erasureId: unfinishedErasure, key: 'c'.repeat(64) },
    ];
    for (const erasureId of [completeErasure, unfinishedErasure])
      await d.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'user_test', 'reconcile test', '{"profiles":1}')`,
        [d.workspace, erasureId],
      );
    for (const { erasureId, key } of keys)
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
        [d.workspace, key, erasureId],
      );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'complete', 3, true, true,
               7, now(), now(), now())`,
      [d.workspace, completeErasure],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'failed', 36, true, true)`,
      [d.workspace, unfinishedErasure],
    );

    // The ClickHouse point still holds one of the two complete erasure's keys; the rest were lost.
    const present = new Set<string>([keys[0]!.key]);
    const published: { key: string; generation: number; erasureId: string }[] = [];
    const visibilityCalls: string[][] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set(present);
      },
      async publishErasedSubjects(rows: readonly { key: string; generation: number; erasureId: string }[]) {
        for (const row of rows) {
          published.push({ key: row.key, generation: row.generation, erasureId: row.erasureId });
          present.add(row.key);
        }
      },
      async erasedSubjectsVisible(_workspaceId: string, wanted: readonly string[]) {
        visibilityCalls.push([...wanted]);
        return wanted.every((key) => present.has(key));
      },
    };

    // Three keys at two per FINAL read: more than one chunk, which is what broke at 10,000 keys
    // ("Field value too long") when the whole set travelled in one parameter (#1194 review).
    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: d.url.toString(),
      events,
      log: () => {},
      batchSize: 2,
    });
    expect(result).toMatchObject({ workspaces: 1, keys: 3, inserted: 2, batches: 1, jobs: 2 });
    expect(published).toHaveLength(2);
    expect(published.every((row) => row.generation === 1)).toBe(true);
    expect(published.map((row) => row.key).sort()).toEqual([keys[1]!.key, keys[2]!.key].sort());
    expect(visibilityCalls.map((chunk) => chunk.length)).toEqual([2, 1]);

    const jobs = await d.db.admin.query<{
      erasure_id: string;
      state: string;
      attempts: number;
      published_generation: string;
      published_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT erasure_id, state, attempts, published_generation, published_at, completed_at
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 ORDER BY erasure_id`,
      [d.workspace],
    );
    const byErasure = new Map(jobs.rows.map((row) => [row.erasure_id, row]));
    // A complete job is confirmed but not reopened: no new sweep, no reset attempts.
    expect(byErasure.get(completeErasure)).toMatchObject({
      state: 'complete',
      attempts: 3,
      published_generation: '1',
      published_at: expect.any(Date),
      completed_at: expect.any(Date),
    });
    // An unfinished job is queued for its remaining sweep, with the publication already recorded.
    expect(byErasure.get(unfinishedErasure)).toMatchObject({
      state: 'pending_external',
      attempts: 0,
      published_generation: '1',
      published_at: expect.any(Date),
    });
    // A restored ClickHouse point may carry rows from before a purge, so progress is reset.
    const generations = await d.db.admin.query<{ purged_generation: string }>(
      'SELECT purged_generation FROM erasure_generations WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(generations.rows[0]?.purged_generation).toBe('0');

    // Idempotent: everything is visible and every job is already published.
    const again = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {}, batchSize: 2 });
    expect(again).toMatchObject({ workspaces: 1, keys: 3, inserted: 0, batches: 0, jobs: 2 });
    expect(published).toHaveLength(2);
    expect(visibilityCalls.map((chunk) => chunk.length)).toEqual([2, 1, 2, 1]);
  }, 120_000);

  it('cleans a completed job’s outbox rows before confirming it complete (#1194 review)', async () => {
    const d = await createDisposableDb('restore_outbox');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000c33';
    const erasedProfile = 'prf_00000000000000000000000000000002';
    const otherProfile = 'prf_00000000000000000000000000000003';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'restore outbox test', '{"profiles":1}')`,
      [d.workspace, erasureId, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
      [d.workspace, 'd'.repeat(64), erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 2, true, true, 4, now(), now(), now())`,
      [d.workspace, erasureId, erasedProfile],
    );
    // The pre-erasure snapshot can carry rows queued before the erasure. The failed ones are what
    // the worker's own final pass would drop; the pending one would otherwise be published by the
    // started app after the restore.
    const outbox = [
      { id: 'ob_segment_failed', kind: 'segment_change', state: 'failed', profile: erasedProfile, batch: true },
      { id: 'ob_message_failed', kind: 'message_event', state: 'failed', profile: erasedProfile, batch: true },
      { id: 'ob_message_pending', kind: 'message_event', state: 'pending', profile: erasedProfile, batch: true },
      { id: 'ob_other_failed', kind: 'message_event', state: 'failed', profile: otherProfile, batch: true },
    ];
    for (const row of outbox)
      await d.db.admin.query(
        `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
         VALUES ($1, $2, $3, $4::jsonb, $2, $5, 3)`,
        [
          d.workspace,
          row.id,
          row.kind,
          JSON.stringify({
            events: [{ workspaceId: d.workspace, properties: { profile_id: row.profile }, profileId: row.profile }],
          }),
          row.state,
        ],
      );

    const published: string[] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set<string>();
      },
      async publishErasedSubjects(rows: readonly { key: string }[]) {
        for (const row of rows) published.push(row.key);
      },
      async erasedSubjectsVisible() {
        return true;
      },
    };
    const result = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {} });
    expect(result).toMatchObject({ workspaces: 1, inserted: 1, jobs: 1, outboxRows: 3, outboxDeferred: 0 });
    expect(published).toEqual(['d'.repeat(64)]);

    const left = await d.db.admin.query<{ id: string }>(`SELECT id FROM outbox WHERE workspace_id = $1`, [d.workspace]);
    expect(left.rows.map((row) => row.id)).toEqual(['ob_other_failed']);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete' });
    expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
  }, 120_000);

  it('reconciles a restored ledger row as a non-BYPASSRLS table owner (#1194 review)', async () => {
    const d = await createDisposableDb('restore_reconcile_rls');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000d44';
    const key = 'e'.repeat(64);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000004']::text[], 'user_test', 'restore rls test', '{"profiles":1}')`,
      [d.workspace, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
      [d.workspace, key, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000004']::text[], 'complete', 1, true, true,
               3, now(), now(), now())`,
      [d.workspace, erasureId],
    );

    // A small install runs the restore as the owner of the tables, which is subject to FORCE RLS.
    // The ledger is invisible to that role until each transaction names its workspace.
    const suffix = randomBytes(4).toString('hex');
    const role = `am_restore_owner_${suffix}`;
    await d.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-password' NOSUPERUSER NOBYPASSRLS`);
    for (const table of ['erasure_keys', 'erasure_cleanup_jobs', 'erasure_generations', 'outbox'])
      await d.db.admin.query(`ALTER TABLE ${table} OWNER TO ${role}`);
    const limited = new URL(d.url.toString());
    limited.username = role;
    limited.password = 'rls-password';

    // Prove the premise: the owner sees no ledger row without `app.workspace_id`.
    const asOwner = new pg.Client({ connectionString: limited.toString() });
    await asOwner.connect();
    try {
      const { rows } = await asOwner.query<{ n: number }>(`SELECT count(*)::int AS n FROM erasure_keys`);
      expect(rows[0]?.n).toBe(0);
    } finally {
      await asOwner.end();
    }

    const published: string[] = [];
    const events = {
      async erasedSubjectKeys() {
        return new Set<string>();
      },
      async publishErasedSubjects(rows: readonly { key: string }[]) {
        for (const row of rows) published.push(row.key);
      },
      async erasedSubjectsVisible() {
        return true;
      },
    };
    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: limited.toString(),
      events,
      log: () => {},
    });
    expect(result).toMatchObject({ workspaces: 1, keys: 1, inserted: 1, jobs: 1, outboxRows: 0 });
    expect(published).toEqual([key]);

    // FORCE is back after the enumeration transaction, and the job was confirmed.
    const forced = await d.db.admin.query<{ forced: boolean }>(
      `SELECT relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'erasure_keys'`,
    );
    expect(forced.rows[0]?.forced).toBe(true);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete' });
    expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
  }, 120_000);
});
