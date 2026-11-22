import {
  APP_DATABASE_APPLICATION_NAME,
  clearRestoreFence,
  nextErasureGeneration,
  noteErasedSubjectsVisible,
  RESTORE_ADVISORY_LOCK_KEY,
  raiseRestoreFence,
  restoreFenceState,
} from '@agentic-marketing/db';
import { clickHouseStore, type EventStore, type SubjectKeyKind } from '@agentic-marketing/events';
import pg from 'pg';

/**
 * The last step of `am restore` (#1194): make sure ClickHouse's `erased_subjects` holds every
 * full-coverage key of the **restored** erasure ledger.
 *
 * The table is not part of the Postgres snapshot, and the ClickHouse point can predate an
 * erasure's publication: an older `--clickhouse` file, a Postgres-only restore after ClickHouse
 * loss, or a fresh target whose dump already carried the completed cleanup job. Replaying only the
 * live erasure log cannot repair those shapes, because a fresh target has no live entries at all.
 * Reconciling from `erasure_keys` after the final ClickHouse load covers every shape and needs no
 * plaintext: the ledger already stores the HMAC values that belong in `erased_subjects`.
 *
 * The restore happens with the app stopped (enforced by the drain check in `backup-lib.ts`), so no
 * running scheduler can claim a job between the load and this step. Only after every key is
 * confirmed visible does this mark the corresponding jobs published; a job that was still
 * unfinished is left queued for its remaining sweep, and a completed one is not reopened. The
 * existing bounded recurring purge handles restored rows physically.
 *
 * A crash anywhere between the Postgres replacement and this step leaves the fence row in
 * `public.restore_fence` (written before the replacement, excluded from every dump) and the
 * session-level restore lock gone with the process. A server refuses to start while the fence
 * exists; rerunning the same restore clears it after reconciliation (#1194 review).
 */

/** What one reconciliation did, for the restore log and its tests. */
export interface ReconcileRestoreResult {
  /** Workspaces whose restored ledger had at least one publishable key. */
  workspaces: number;
  /** Full-coverage ledger keys checked. */
  keys: number;
  /** Keys that were missing from `erased_subjects` and were inserted. */
  inserted: number;
  /** Batches the inserts were split into. */
  batches: number;
  /** Cleanup jobs whose publication record was recorded or refreshed. */
  jobs: number;
}

export interface ReconcileRestoreOptions {
  databaseUrl: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /**
   * Test seam. Without one, the function opens a ClickHouse store from `CLICKHOUSE_URL` and
   * `CLICKHOUSE_DATABASE` and closes it before returning.
   */
  events?: Pick<EventStore, 'publishErasedSubjects' | 'erasedSubjectsVisible' | 'erasedSubjectKeys'>;
  /** Keys per insert. Defaults to 1000. */
  batchSize?: number;
}

interface LedgerRow {
  workspace_id: string;
  erasure_id: string;
  kind: string;
  key_value: string;
  key_version: string;
}

const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Refuses a restore while an application process is connected to the target database (#1194).
 *
 * `am restore` documents "stop the app first". Before this check the scheduler could run during a
 * restore: the replay made jobs claimable and a worker could record a publication, after which the
 * ClickHouse load replaced `erased_subjects` with an older point. The check is the documented drain,
 * enforced: every server pool announces `APP_DATABASE_APPLICATION_NAME`, so any open connection
 * means a live app process. The restore's own connections use a different (or empty) name.
 */
export async function assertDatabaseDrained(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND pid <> pg_backend_pid()`,
      [APP_DATABASE_APPLICATION_NAME],
    );
    const active = Number(rows[0]?.n ?? 0);
    if (active > 0)
      throw new Error(
        `${active} application process(es) are still connected to this database, so a restore must not run: ` +
          'a scheduler or worker could republish an erasure between the Postgres load and the ClickHouse load. ' +
          'Stop every app, worker and scheduler process first (docker compose stop app), then retry.',
      );
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Reconciles the restored ledger with ClickHouse and records the confirmation on the jobs. Runs
 * after the final ClickHouse load, before the restore reports success. Throws when the keys cannot
 * be published or confirmed visible, leaving the pending-restore marker in place so the app refuses
 * to serve reads until a restore completes.
 */
export async function reconcileRestoredErasureExclusions(opts: ReconcileRestoreOptions): Promise<ReconcileRestoreResult> {
  const result: ReconcileRestoreResult = { workspaces: 0, keys: 0, inserted: 0, batches: 0, jobs: 0 };
  const log = opts.log ?? (() => {});
  const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 2 });
  const env = opts.env ?? process.env;
  const store =
    opts.events === undefined
      ? clickHouseStore({
          url: env.CLICKHOUSE_URL ?? 'http://localhost:8123',
          database: env.CLICKHOUSE_DATABASE?.trim() || 'am',
        })
      : undefined;
  const events = opts.events ?? store!;
  try {
    // A snapshot from before 0.17.0 has no durable ledger: the marker was tolerated, and there is
    // nothing in it that a protected read could exclude.
    const table = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.erasure_keys') IS NOT NULL AND to_regclass('public.erasure_cleanup_jobs') IS NOT NULL AS present",
    );
    if (!table.rows[0]?.present) return result;

    const { rows } = await pool.query<LedgerRow>(
      `SELECT workspace_id, erasure_id, kind, key_value, key_version
         FROM erasure_keys
        WHERE coverage = 'full'
        ORDER BY workspace_id, erasure_id, kind, key_value, key_version`,
    );
    if (!rows.length) return result;

    const byWorkspace = new Map<string, LedgerRow[]>();
    for (const row of rows) {
      const list = byWorkspace.get(row.workspace_id);
      if (list) list.push(row);
      else byWorkspace.set(row.workspace_id, [row]);
    }

    for (const [workspaceId, ledger] of byWorkspace) {
      const keys = [...new Set(ledger.map((row) => row.key_value))];
      const erasureIds = [...new Set(ledger.map((row) => row.erasure_id))];
      const existing = await events.erasedSubjectKeys(workspaceId);
      const missing = ledger.filter((row) => !existing.has(row.key_value));
      // A new generation for the whole restored publication: a retry or a later restore can never
      // make the confirmed state regress. Inserting only the missing keys keeps the work bounded by
      // what the ClickHouse point actually lost.
      const generation = await nextErasureGeneration({ admin: pool }, workspaceId);
      const recordedAt = new Date().toISOString();
      for (let offset = 0; offset < missing.length; offset += batchSize) {
        const batch = missing.slice(offset, offset + batchSize);
        await events.publishErasedSubjects(
          batch.map((row) => ({
            workspaceId,
            kind: row.kind as SubjectKeyKind,
            key: row.key_value,
            keyVersion: row.key_version,
            erasureId: row.erasure_id,
            generation,
            recordedAt,
          })),
        );
        result.batches += 1;
      }
      // Chunk the FINAL visibility read: one HTTP parameter with every key of a large workspace hit
      // ClickHouse's "Field value too long" at 10,000 keys. The inserts above are already batched;
      // the confirmation must be too. Every chunk checks its own set, so the whole list is still
      // confirmed before a job is marked published.
      let visible = true;
      for (let offset = 0; offset < keys.length; offset += batchSize) {
        if (!(await events.erasedSubjectsVisible(workspaceId, keys.slice(offset, offset + batchSize)))) {
          visible = false;
          break;
        }
      }
      if (!visible)
        throw new Error(
          `the restored erasure exclusions for workspace ${workspaceId} are not visible in ClickHouse after the publication; ` +
            'reads stay blocked until a restore completes the reconciliation',
        );
      // The cache epoch moves only after the FINAL read; the restored process has no warm cache,
      // but a publication that moved the epoch before its rows were visible is exactly what this
      // rule exists to prevent.
      await noteErasedSubjectsVisible({ admin: pool }, workspaceId);

      // Only now may the jobs say they published. A finished job stays complete and is not queued
      // for another sweep; an unfinished one is made due so its remaining sweep runs. The marker
      // and the confirmed keys are what protect reads in between.
      const published = await pool.query(
        `UPDATE erasure_cleanup_jobs
            SET published_generation = $2,
                published_at = COALESCE(published_at, now()),
                state = CASE WHEN state = 'complete' THEN state ELSE 'pending_external' END,
                attempts = CASE WHEN state = 'complete' THEN attempts ELSE 0 END,
                next_attempt_at = CASE WHEN state = 'complete' THEN next_attempt_at ELSE now() END,
                claim_token = CASE WHEN state = 'complete' THEN claim_token ELSE NULL END,
                lease_until = CASE WHEN state = 'complete' THEN lease_until ELSE NULL END,
                completion_reason = CASE WHEN state = 'complete' THEN completion_reason ELSE NULL END,
                last_error = CASE WHEN state = 'complete' THEN last_error ELSE NULL END,
                updated_at = now()
          WHERE workspace_id = $1 AND erasure_id = ANY($3::text[])`,
        [workspaceId, generation, erasureIds],
      );
      result.jobs += published.rowCount ?? 0;
      // A restored ClickHouse may carry rows from before a physical purge, so purge progress is not
      // evidence after a load: reset it and let the bounded recurring sweep run again (#1037 part 3).
      await pool.query(
        `UPDATE erasure_generations
            SET purged_generation = 0, purge_last_sweep_at = NULL,
                purge_claim_token = NULL, purge_lease_until = NULL, updated_at = now()
          WHERE workspace_id = $1`,
        [workspaceId],
      );

      result.workspaces += 1;
      result.keys += keys.length;
      result.inserted += missing.length;
      log(
        `workspace ${workspaceId}: ${keys.length} restored exclusion key(s), ` +
          `${missing.length} re-published under generation ${generation}, ${published.rowCount ?? 0} cleanup job(s) confirmed`,
      );
    }
    return result;
  } finally {
    if (store) await store.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

/**
 * Runs the whole final step: reconcile the restored ledger, then clear the fence the caller raised
 * before the Postgres replacement. A reconciliation failure leaves the fence in place, so a server
 * started in between still refuses to serve.
 */
export async function finishRestoreReconciliation(opts: ReconcileRestoreOptions): Promise<ReconcileRestoreResult> {
  const result = await reconcileRestoredErasureExclusions(opts);
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  try {
    await clearRestoreFence(pool);
  } finally {
    await pool.end().catch(() => {});
  }
  return result;
}

/**
 * Raises the fence before anything replaces Postgres (#1194). The row lives outside every dump, so
 * a `pg_restore` that commits and then fails leaves it behind; a retry overwrites it and a server
 * started in between refuses to serve reads. It is deliberately not cleared on failure: only
 * reconciliation (or the explicit `am restore --clear-fence`) may remove it.
 */
export async function markRestoreStarted(databaseUrl: string, backup: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await raiseRestoreFence(pool, { backup, startedAt: new Date().toISOString() });
  } finally {
    await pool.end().catch(() => {});
  }
}

/** The advisory lock a restore holds on one dedicated session for its whole run. */
export interface RestoreSessionLock {
  release(): Promise<void>;
}

/**
 * Takes the exclusive restore advisory lock (#1194). It is session state, not data, so it survives
 * `pg_restore`; a second restore — even one restoring another backup directory — is refused instead
 * of racing the first through its marker and ClickHouse load. The caller must hold it until the
 * fence is cleared.
 */
export async function acquireRestoreSessionLock(databaseUrl: string): Promise<RestoreSessionLock> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
    if (!rows[0]?.locked)
      throw new Error(
        'another restore is running: it holds the restore advisory lock on this database. Wait for it to finish, then retry.',
      );
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  return {
    async release() {
      await client.query('SELECT pg_advisory_unlock($1)', [RESTORE_ADVISORY_LOCK_KEY]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * What a server start must refuse for (#1194), or null when it may serve. Runs before any listener
 * opens. An unfinished restore is a fence row; a restore in progress holds the exclusive advisory
 * lock, which a shared attempt fails to get. The shared lock is released immediately when it was
 * taken: startup only needs to prove no restore is active, not to keep restores out afterwards
 * (the drain check covers a server that was already running).
 */
export async function restoreStartupBlock(databaseUrl: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const fence = await restoreFenceState(client);
    if (fence)
      return (
        `A restore of ${fence.backup} started at ${fence.startedAt} did not finish reconciling erasure exclusions. ` +
        'Refusing to serve person-linked reads until it does; run `am restore` for that backup again to completion, ' +
        'or `am restore --clear-fence` to abandon it deliberately.'
      );
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock_shared($1) AS locked', [
      RESTORE_ADVISORY_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) return 'A restore is running on this database. Stop it or wait for it to finish before starting the app.';
    await client.query('SELECT pg_advisory_unlock_shared($1)', [RESTORE_ADVISORY_LOCK_KEY]);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The deliberate escape hatch behind `am restore --clear-fence`. It only removes the fence; the
 * caller has to have decided that the ClickHouse exclusions are correct (or acceptable) already.
 * Returns false when there was no fence to clear.
 */
export async function clearRestoreFenceForUrl(databaseUrl: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const before = await restoreFenceState(pool);
    if (!before) return false;
    await clearRestoreFence(pool);
    return true;
  } finally {
    await pool.end().catch(() => {});
  }
}
