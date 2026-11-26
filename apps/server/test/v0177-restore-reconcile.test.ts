import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRestoreFence,
  RESTORE_ADVISORY_LOCK_KEY,
  RESTORE_APPLICATION_NAME,
  type RestoreFenceState,
  raiseRestoreFence,
  restoreFenceState,
  withRestoreAppName,
} from '@agentic-marketing/db';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { restoreClickHouse, restorePostgres, runningRestoreChildren, runRestoreChild, stopRestoreChildren } from '../src/ops/backup-lib';
import {
  acquireRestoreSessionLock,
  assertRestoreWorkDrained,
  finishRestoreReconciliation,
  RESTORE_CLICKHOUSE_QUERY_PREFIX,
  reconcileRestoredErasureExclusions,
} from '../src/ops/restore-reconcile';

// The restore's final step (#1194). It must publish only what the ClickHouse point lost, record the
// confirmation on the jobs, and leave a completed job complete instead of reopening every
// historical sweep. These tests use a fake ClickHouse store: the SQL and batching are what matter.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';

/**
 * A ClickHouse HTTP endpoint that rejects the `SQL_workspace` setting as a server without the `SQL_`
 * custom-settings prefix does, and answers every other request with zero rows. Built without the
 * configured row-policy mode, the reconciliation read that empty answer as "nothing to publish".
 */
async function unknownSettingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.has('SQL_workspace')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end("Code: 115. DB::Exception: Unknown setting 'SQL_workspace'. (UNKNOWN_SETTING)");
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

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

  // #1225 review: the reconciliation built its own store without the configured row-policy mode. A
  // restored workspace read that the policy hides returned zero rows, so the reconciliation
  // believed there was nothing left to publish instead of refusing.
  it('refuses a restored read when required policies meet a server that rejects SQL_workspace', async () => {
    const d = await createDisposableDb('restore_reconcile_policies');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000c33';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000001']::text[], 'user_test', 'row policy test', '{"profiles":1}')`,
      [d.workspace, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_policies', $3, 'full')`,
      [d.workspace, 'd'.repeat(64), erasureId],
    );
    const stub = await unknownSettingServer();
    try {
      await expect(
        reconcileRestoredErasureExclusions({
          databaseUrl: d.url.toString(),
          env: { CLICKHOUSE_URL: stub.url, CLICKHOUSE_DATABASE: 'am', CLICKHOUSE_ROW_POLICIES: 'required' },
          log: () => {},
        }),
      ).rejects.toThrow(/SQL_workspace|refusing to read/);
    } finally {
      await stub.close();
    }
  }, 60_000);

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

  it('publishes each workspace’s restored ledger only into that workspace (#1204 review)', async () => {
    const d = await createDisposableDb('restore_reconcile_multi');
    open.push(d);
    // A second tenant: RLS would separate these rows for the app, but a restore commonly runs as a
    // superuser or a BYPASSRLS role, which sees both workspaces in one query. Every publication
    // row must still name the workspace whose ledger it came from.
    const other = randomUUID();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other restore', 'none')", [other]);
    const fixtures = [
      {
        workspace: d.workspace,
        erasureId: 'era_00000000000000000000000000000e55',
        key: 'f'.repeat(64),
        profile: 'prf_00000000000000000000000000000005',
      },
      {
        workspace: other,
        erasureId: 'era_00000000000000000000000000000e66',
        key: '1'.repeat(64),
        profile: 'prf_00000000000000000000000000000006',
      },
    ];
    for (const fixture of fixtures) {
      await d.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'multi-workspace reconcile test', '{"profiles":1}')`,
        [fixture.workspace, fixture.erasureId, fixture.profile],
      );
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_reconcile', $3, 'full')`,
        [fixture.workspace, fixture.key, fixture.erasureId],
      );
      await d.db.admin.query(
        `INSERT INTO erasure_cleanup_jobs
           (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
            published_generation, published_at, coverage_cleared_at, completed_at)
         VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
        [fixture.workspace, fixture.erasureId, fixture.profile],
      );
    }

    // ClickHouse state is per workspace: a key published under the wrong workspace would never hide
    // that person's reads, and would leak the key into a tenant it does not belong to.
    const present = new Map<string, Set<string>>();
    const published: { workspaceId: string; key: string }[] = [];
    const events = {
      async erasedSubjectKeys(workspaceId: string) {
        return new Set(present.get(workspaceId) ?? []);
      },
      async publishErasedSubjects(rows: readonly { workspaceId: string; key: string }[]) {
        for (const row of rows) {
          published.push({ workspaceId: row.workspaceId, key: row.key });
          const keys = present.get(row.workspaceId) ?? new Set<string>();
          keys.add(row.key);
          present.set(row.workspaceId, keys);
        }
      },
      async erasedSubjectsVisible(workspaceId: string, wanted: readonly string[]) {
        const keys = present.get(workspaceId) ?? new Set<string>();
        return wanted.every((key) => keys.has(key));
      },
    };

    const result = await reconcileRestoredErasureExclusions({ databaseUrl: d.url.toString(), events, log: () => {} });
    expect(result).toMatchObject({ workspaces: 2, keys: 2, inserted: 2, jobs: 2 });
    const byWorkspace = (a: { workspaceId: string }, b: { workspaceId: string }) => (a.workspaceId < b.workspaceId ? -1 : 1);
    expect(published.sort(byWorkspace)).toEqual(fixtures.map(({ workspace, key }) => ({ workspaceId: workspace, key })).sort(byWorkspace));
  }, 120_000);

  it('cleans a completed job’s outbox rows even when it has no publishable keys (#1204 review)', async () => {
    const d = await createDisposableDb('restore_outbox_nokeys');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000f77';
    const erasedProfile = 'prf_00000000000000000000000000000007';
    const otherProfile = 'prf_00000000000000000000000000000008';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'restore keyless outbox test', '{"profiles":1}')`,
      [d.workspace, erasureId, erasedProfile],
    );
    // A job that completed before the durable ledger (or on a generation-0 publication) has no
    // publishable key at all. Its final outbox pass still has to happen after a restore.
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, completed_at)
       VALUES ($1, $2, ARRAY[$3]::text[], 'complete', 4, true, true, 0, NULL, now())`,
      [d.workspace, erasureId, erasedProfile],
    );
    const outbox = [
      { id: 'ob_keyless_failed', state: 'failed', profile: erasedProfile },
      { id: 'ob_keyless_pending', state: 'pending', profile: erasedProfile },
      { id: 'ob_keyless_other', state: 'failed', profile: otherProfile },
    ];
    for (const row of outbox)
      await d.db.admin.query(
        `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
         VALUES ($1, $2, 'message_event', $3::jsonb, $2, $4, 3)`,
        [
          d.workspace,
          row.id,
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
    // Nothing was publishable, so nothing is claimed as published, but the outbox is cleaned.
    expect(result).toMatchObject({ workspaces: 0, keys: 0, inserted: 0, jobs: 0, outboxRows: 2, outboxDeferred: 0 });
    expect(published).toEqual([]);
    const left = await d.db.admin.query<{ id: string }>('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
    expect(left.rows.map((row) => row.id)).toEqual(['ob_keyless_other']);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(job.rows[0]).toMatchObject({ state: 'complete', published_at: null });
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

  it('reports a lost exclusive restore lock and stops its children (#1204 review)', async () => {
    const d = await createDisposableDb('restore_session_lock_lost');
    open.push(d);
    const databaseUrl = d.url.toString();
    let lost = '';
    // A stand-in for `pg_restore`: a child that outlives the lock holder would keep writing into a
    // database another restore may already own. Its rejection is handled from the start, because
    // the lock loss can stop it before the assertion below runs.
    const child = runRestoreChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {}).then(
      () => 'exited' as const,
      () => 'killed' as const,
    );
    const session = await acquireRestoreSessionLock(databaseUrl, {
      onLost: (err) => {
        lost = err.message;
        void stopRestoreChildren();
      },
    });
    try {
      const found = Date.now() + 5_000;
      while (runningRestoreChildren() === 0 && Date.now() < found) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runningRestoreChildren()).toBe(1);
      // The backend that holds the session lock, found the way an operator would: by its lock. The
      // key is per database, and other servers on the same cluster hold it in theirs.
      const finder = new pg.Client({ connectionString: databaseUrl });
      await finder.connect();
      try {
        const { rows } = await finder.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND granted AND pid <> pg_backend_pid()
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [RESTORE_ADVISORY_LOCK_KEY],
        );
        expect(rows).toHaveLength(1);
        await finder.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      } finally {
        await finder.end();
      }
      await expect(child).resolves.toBe('killed');
      const deadline = Date.now() + 15_000;
      while (!lost && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lost).toMatch(/terminat|connection/i);
      expect(runningRestoreChildren()).toBe(0);
    } finally {
      await stopRestoreChildren();
      await session.release();
    }
  }, 120_000);

  it('stops a child that ignores SIGTERM before reporting the restore stopped (#1204 review)', async () => {
    // A `pg_restore` that ignores SIGTERM must still be gone before the process exits: the old
    // handler returned immediately after scheduling SIGKILL, so `process.exit` won the race and the
    // child outlived the interlock.
    const ready = join(tmpdir(), `am-restore-child-${randomUUID()}`);
    const child = runRestoreChild(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');` +
          "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);",
      ],
      {},
    ).then(
      () => 'exited' as const,
      () => 'killed' as const,
    );
    // The handler is installed only once Node has evaluated the script; SIGTERM before that uses the
    // default disposition and would not test the escalation.
    const installed = Date.now() + 5_000;
    while (!existsSync(ready) && Date.now() < installed) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(ready)).toBe(true);
    expect(runningRestoreChildren()).toBe(1);
    const started = Date.now();
    await stopRestoreChildren();
    // It had to be escalated, and the promise only resolved once the child was actually gone.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(runningRestoreChildren()).toBe(0);
    await expect(child).resolves.toBe('killed');
    await rm(ready, { force: true });
  }, 120_000);

  it('clears a fence only when it belongs to the attempt clearing it (#1204 review)', async () => {
    const d = await createDisposableDb('restore_fence_owner');
    open.push(d);
    const attemptOne = { backup: '/backups/attempt-one', startedAt: '2026-11-01T00:00:00.000Z' };
    const attemptTwo = { backup: '/backups/attempt-two', startedAt: '2026-11-02T00:00:00.000Z' };
    await raiseRestoreFence(d.db.admin, attemptTwo);

    // A late write from an attempt that no longer holds the lock must not remove the current fence.
    await clearRestoreFence(d.db.admin, attemptOne);
    expect(await restoreFenceState(d.db.admin)).toEqual(attemptTwo);

    // Its own row is still cleared.
    await clearRestoreFence(d.db.admin, attemptTwo);
    expect(await restoreFenceState(d.db.admin)).toBeNull();
  }, 120_000);

  it('leaves another attempt’s fence and does no further work after the lock is lost (#1204 review)', async () => {
    const d = await createDisposableDb('restore_fence_lost');
    open.push(d);
    const erasedProfile = 'prf_00000000000000000000000000000007';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_00000000000000000000000000000d77', ARRAY[$2]::text[], 'user_test', 'lost lock test', '{"profiles":1}')`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, 'era_00000000000000000000000000000d77', ARRAY[$2]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
       VALUES ($1, 'ob_lost_lock', 'message_event',
               jsonb_build_object('events', jsonb_build_array(jsonb_build_object('profileId', $2::text))),
               'ob_lost_lock', 'pending', 0)`,
      [d.workspace, erasedProfile],
    );
    // The reviewer's scenario: attempt #1 holds the lock and raised its fence, its backend is
    // terminated, attempt #2 takes the lock and raises its own fence, and #1 then reaches the end of
    // its run. Before the fix, #1's reconciliation cleared #2's fence through a separate connection.
    const databaseUrl = d.url.toString();
    const attemptOne: RestoreFenceState = { backup: '/backups/attempt-one', startedAt: '2026-11-01T00:00:00.000Z' };
    let lost: Error | null = null;
    const abort = new AbortController();
    const sessionOne = await acquireRestoreSessionLock(databaseUrl, {
      onLost: (err) => {
        lost = err;
        abort.abort(err);
      },
    });
    await raiseRestoreFence(sessionOne.client, attemptOne);
    const finder = new pg.Client({ connectionString: databaseUrl });
    await finder.connect();
    try {
      const { rows } = await finder.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND granted AND pid <> pg_backend_pid()
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [RESTORE_ADVISORY_LOCK_KEY],
      );
      expect(rows).toHaveLength(1);
      await finder.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
    } finally {
      await finder.end();
    }
    const lostBy = Date.now() + 15_000;
    while (!lost && Date.now() < lostBy) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).toBeInstanceOf(Error);

    // Attempt #2 may need a moment to see the ended backend's session lock released.
    let sessionTwo: Awaited<ReturnType<typeof acquireRestoreSessionLock>> | undefined;
    const freeBy = Date.now() + 15_000;
    while (!sessionTwo && Date.now() < freeBy) {
      sessionTwo = await acquireRestoreSessionLock(databaseUrl).catch(() => undefined);
      if (!sessionTwo) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sessionTwo).toBeDefined();
    const attemptTwo: RestoreFenceState = { backup: '/backups/attempt-two', startedAt: new Date().toISOString() };
    await raiseRestoreFence(sessionTwo!.client, attemptTwo);

    try {
      await expect(
        finishRestoreReconciliation({
          databaseUrl,
          events: {
            async erasedSubjectKeys() {
              throw new Error('ClickHouse must not be read after the restore lock was lost');
            },
            async publishErasedSubjects() {
              throw new Error('ClickHouse must not be written after the restore lock was lost');
            },
            async erasedSubjectsVisible() {
              throw new Error('ClickHouse must not be read after the restore lock was lost');
            },
          },
          log: () => {},
          signal: abort.signal,
          fence: attemptOne,
          fenceClient: sessionOne.client,
        }),
      ).rejects.toThrow(/terminat|connection|lost/i);
      expect(await restoreFenceState(d.db.admin)).toEqual(attemptTwo);
      // The completed job's outbox pass is a write too: it did not run after the loss.
      const outbox = await d.db.admin.query('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
      expect(outbox.rows.map((row) => row.id)).toEqual(['ob_lost_lock']);
    } finally {
      await sessionTwo!.release();
      await sessionOne.release();
    }
  }, 120_000);

  it('issues no second visibility check after its signal aborts (#1204 review)', async () => {
    const d = await createDisposableDb('restore_visibility_abort');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000000ab1';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_00000000000000000000000000000ab1']::text[], 'user_test', 'abort test', '{"profiles":1}')`,
      [d.workspace, erasureId],
    );
    for (const key of ['a'.repeat(64), 'b'.repeat(64)])
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_abort', $3, 'full')`,
        [d.workspace, key, erasureId],
      );

    // The lock is lost while the first chunk's answer is in flight; the installed client would
    // still send the next request with an already-aborted signal, so the loop checks first.
    const abort = new AbortController();
    const checks: string[][] = [];
    await expect(
      reconcileRestoredErasureExclusions({
        databaseUrl: d.url.toString(),
        batchSize: 1,
        signal: abort.signal,
        log: () => {},
        events: {
          async erasedSubjectKeys() {
            return new Set<string>();
          },
          async publishErasedSubjects() {},
          async erasedSubjectsVisible(_workspaceId, keys) {
            checks.push([...keys]);
            abort.abort(new Error('the restore lock was lost'));
            return true;
          },
        },
      }),
    ).rejects.toThrow(/restore lock was lost/);
    // Two keys in one-key chunks: only the first chunk's request went out.
    expect(checks).toHaveLength(1);
  }, 120_000);

  it('cleans a completed job’s outbox when the restored snapshot predates the erasure ledger (#1204 review)', async () => {
    const d = await createDisposableDb('restore_outbox_no_ledger');
    open.push(d);
    const erasedProfile = 'prf_00000000000000000000000000000008';
    // A snapshot at the 0110 schema: the cleanup job table exists, the durable ledger does not.
    await d.db.admin.query('DROP TABLE erasure_keys');
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_00000000000000000000000000000e88', ARRAY[$2]::text[], 'user_test', 'pre-ledger restore', '{"profiles":1}')`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, clickhouse_done, hotstate_done,
          published_generation, published_at, coverage_cleared_at, completed_at)
       VALUES ($1, 'era_00000000000000000000000000000e88', ARRAY[$2]::text[], 'complete', 1, true, true, 2, now(), now(), now())`,
      [d.workspace, erasedProfile],
    );
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts)
       VALUES ($1, 'ob_pre_ledger', 'message_event',
               jsonb_build_object('events', jsonb_build_array(jsonb_build_object('profileId', $2::text))),
               'ob_pre_ledger', 'pending', 0)`,
      [d.workspace, erasedProfile],
    );

    const result = await reconcileRestoredErasureExclusions({
      databaseUrl: d.url.toString(),
      events: {
        async erasedSubjectKeys() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
        async publishErasedSubjects() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
        async erasedSubjectsVisible() {
          throw new Error('a snapshot without erasure_keys has nothing to publish');
        },
      },
      log: () => {},
    });
    expect(result).toMatchObject({ workspaces: 0, keys: 0, inserted: 0, jobs: 0, outboxRows: 1 });
    const left = await d.db.admin.query('SELECT id FROM outbox WHERE workspace_id = $1', [d.workspace]);
    expect(left.rows).toEqual([]);
  }, 120_000);
});

// #1204 review: the exclusive advisory lock is held on one session, so it cannot fence the work the
// previous restore issues on its other connections. A successor waits until that work is gone.
describe.skipIf(!hasTestDatabase())('a restore drains the previous run’s work (#1204 review)', () => {
  it('waits for another backend tagged am-restore, then refuses once its bound passes', async () => {
    const d = await createDisposableDb('restore_drain_pg');
    open.push(d);
    const databaseUrl = d.url.toString();
    const stale = new pg.Client({ connectionString: databaseUrl, application_name: RESTORE_APPLICATION_NAME });
    await stale.connect();
    try {
      const started = Date.now();
      await expect(
        assertRestoreWorkDrained(databaseUrl, { timeoutMs: 2_000, pollMs: 25, env: { CLICKHOUSE_URL: CH_URL } }),
      ).rejects.toThrow(/a previous restore's work is still running/);
      // It waited for the bound instead of proceeding, and the drain's own connection did not
      // count itself. (A generous bound keeps a slow probe under load from ending the wait with a
      // timeout message instead.)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    } finally {
      await stale.end();
    }
    // Once the tagged backend is gone the same drain passes immediately.
    await assertRestoreWorkDrained(databaseUrl, { timeoutMs: 1_000, pollMs: 25, env: { CLICKHOUSE_URL: CH_URL } });
  }, 60_000);

  it('waits for a running ClickHouse request that carries the restore marker', async () => {
    const d = await createDisposableDb('restore_drain_ch');
    open.push(d);
    const queryId = `${RESTORE_CLICKHOUSE_QUERY_PREFIX}drain-${randomUUID()}`;
    // The probe runs in `system` but must look at each running query's own database
    // (`current_database`); `database` there is the probe's constant. Run the marked request in the
    // restore's target database, not in `system`, so a stale predicate misses it (#1204 review).
    const drainEnv = { CLICKHOUSE_URL: CH_URL, CLICKHOUSE_DATABASE: 'default' };
    const running = new URL(CH_URL);
    running.searchParams.set('database', 'default');
    running.searchParams.set('query_id', queryId);
    running.searchParams.set('query', 'SELECT sleep(3)'); // ClickHouse's per-block maximum
    // Leave the query in flight; the request is what system.processes shows, not its result.
    const sleeping = fetch(running, { method: 'POST' }).then(
      (response) => response.text(),
      () => 'killed',
    );
    try {
      // Wait until ClickHouse lists the marked query as running before draining against it.
      const listedBy = Date.now() + 10_000;
      for (;;) {
        const probe = new URL(CH_URL);
        probe.searchParams.set('query', `SELECT count() FROM system.processes WHERE query_id = '${queryId}'`);
        const text = await fetch(probe).then((response) => response.text());
        if (Number(text.trim()) > 0) break;
        if (Date.now() > listedBy) throw new Error('the marked ClickHouse query never appeared in system.processes');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The bound must end well before the 3 s query does, yet leave a slow probe room to answer.
      await expect(assertRestoreWorkDrained(d.url.toString(), { timeoutMs: 1_000, pollMs: 25, env: drainEnv })).rejects.toThrow(
        /a previous restore's work is still running/,
      );
    } finally {
      await sleeping;
    }
    // After the marked request ended, the drain has nothing left to wait for.
    await assertRestoreWorkDrained(d.url.toString(), { timeoutMs: 2_000, pollMs: 25, env: drainEnv });
  }, 60_000);

  it('probes the default ClickHouse endpoint when CLICKHOUSE_URL is unset (#1204 review)', async () => {
    const d = await createDisposableDb('restore_drain_ch_default');
    open.push(d);
    // The ClickHouse load and the reconciliation fall back to localhost:8123 when the environment
    // names no URL. A drain that skipped ClickHouse there would let a predecessor write into the
    // point the successor's own load is about to replace, so it must probe the same endpoint.
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('0', { status: 200 });
    }) as typeof fetch;
    try {
      await assertRestoreWorkDrained(d.url.toString(), { timeoutMs: 1_000, pollMs: 25, env: {} });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requested).toHaveLength(1);
    const probe = new URL(requested[0]!);
    expect(probe.host).toBe('localhost:8123');
    expect(probe.searchParams.get('database')).toBe('system');
    expect(probe.searchParams.get('query')).toContain('current_database');
  }, 60_000);

  it('ends a stalled ClickHouse probe at its bound and refuses (#1204 review)', async () => {
    const d = await createDisposableDb('restore_drain_ch_stall');
    open.push(d);
    // A ClickHouse that accepts the probe and never answers. The drain's own deadline has to abort
    // it; a client without a timeout would keep the restore waiting forever.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('the drain probe had no deadline'));
          return;
        }
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    const started = Date.now();
    try {
      await expect(
        assertRestoreWorkDrained(d.url.toString(), {
          timeoutMs: 200,
          pollMs: 25,
          env: { CLICKHOUSE_URL: 'http://clickhouse.test:8123' },
        }),
      ).rejects.toThrow(/did not finish within/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 60_000);

  it('announces am-restore even when the connection string names another application_name (#1204 review)', async () => {
    const d = await createDisposableDb('restore_appname_override');
    open.push(d);
    const url = new URL(d.url.toString());
    // node-postgres gives `?application_name=` precedence over the client option, so a restore that
    // only set the option would announce `maintenance` and be invisible to a successor's drain.
    url.searchParams.set('application_name', 'maintenance');
    url.searchParams.set('sslmode', 'disable');
    // The helper sets the name in the URL and leaves the other parameters alone.
    const tagged = new URL(withRestoreAppName(url.toString()));
    expect(tagged.searchParams.get('application_name')).toBe(RESTORE_APPLICATION_NAME);
    expect(tagged.searchParams.get('sslmode')).toBe('disable');
    expect(tagged.host).toBe(url.host);
    const session = await acquireRestoreSessionLock(url.toString());
    try {
      const observer = new pg.Client({ connectionString: d.url.toString() });
      await observer.connect();
      try {
        const { rows } = await observer.query<{ application_name: string }>(
          'SELECT application_name FROM pg_stat_activity WHERE pid = $1',
          [session.pid],
        );
        expect(rows[0]?.application_name).toBe(RESTORE_APPLICATION_NAME);
      } finally {
        await observer.end();
      }
    } finally {
      await session.release();
    }
  }, 120_000);
});

describe('a restore tags and stops its own work (#1204 review)', () => {
  it('sends no further ClickHouse request after its signal aborts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'am-restore-ch-abort-'));
    const files = ['one.native', 'two.native'];
    for (const file of files) await writeFile(join(dir, file), 'x');
    const controller = new AbortController();
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      // The lock is lost while the first request is in flight.
      controller.abort(new Error('the restore lock was lost'));
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        restoreClickHouse({
          runDir: dir,
          tables: [{ name: 'events', totalRowsBefore: 0, files: files.map((file) => ({ file, bytes: 1, sha256: 'x', rows: 0 })) }],
          url: 'http://clickhouse.test:8123',
          database: 'am',
          signal: controller.signal,
        }),
      ).rejects.toThrow(/the restore lock was lost/);
      // Only the TRUNCATE went out: the insert was refused before it was sent.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/TRUNCATE/);
      // Every request the restore issues carries the marker the successor waits on.
      expect(requests[0]).toContain(`query_id=${RESTORE_CLICKHOUSE_QUERY_PREFIX}`);
    } finally {
      globalThis.fetch = realFetch;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('loads ClickHouse with synchronous inserts so a successor can see them (#1204 review)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'am-restore-ch-sync-'));
    const files = ['one.native', 'two.native'];
    for (const file of files) await writeFile(join(dir, file), 'x');
    const requests: URL[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)));
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      await restoreClickHouse({
        runDir: dir,
        tables: [{ name: 'events', totalRowsBefore: 0, files: files.map((file) => ({ file, bytes: 1, sha256: 'x', rows: 0 })) }],
        url: 'http://clickhouse.test:8123',
        database: 'am',
      });
      // An async insert returns once it is buffered and then leaves system.processes, so the next
      // restore's drain could not see it land after its own TRUNCATE.
      const inserts = requests.filter((url) => /^INSERT/.test(url.searchParams.get('query') ?? ''));
      expect(inserts).toHaveLength(2);
      for (const url of inserts) {
        expect(url.searchParams.get('async_insert')).toBe('0');
        expect(url.searchParams.get('wait_for_async_insert')).toBe('1');
      }
    } finally {
      globalThis.fetch = realFetch;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs pg_restore with PGAPPNAME=am-restore', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'am-restore-pgappname-'));
    const out = join(bin, 'pgappname.txt');
    // A stand-in `pg_restore` that records the libpq application name its parent handed it.
    await writeFile(join(bin, 'pg_restore'), `#!/bin/sh\nprintf '%s' "$PGAPPNAME" > "${out}"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      await restorePostgres('postgres://am:am@127.0.0.1:5432/am_test', join(bin, 'unused.dump'));
      expect(await readFile(out, 'utf8')).toBe(RESTORE_APPLICATION_NAME);
    } finally {
      process.env.PATH = oldPath;
      await rm(bin, { recursive: true, force: true });
    }
  }, 60_000);
});
