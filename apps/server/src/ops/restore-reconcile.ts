import {
  APP_DATABASE_APPLICATION_NAME,
  clearRestoreFence,
  dropErasedProfileOutbox,
  erasureOutboxOutstanding,
  nextErasureGeneration,
  noteErasedSubjectsVisible,
  RESTORE_ADVISORY_LOCK_KEY,
  type RestoreFenceState,
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
 * The restore happens with the app stopped. `am restore` holds the exclusive restore advisory lock
 * for its whole run, and every server process holds it shared from before its migrations until
 * shutdown, so no running scheduler can claim a job between the load and this step. Only after
 * every key is confirmed visible does this mark the corresponding jobs published; a completed job
 * is not reopened, an unfinished one is left queued for its remaining sweep, and a completed job
 * also gets the outbox cleanup its final worker pass would have done. The existing bounded
 * recurring purge handles restored rows physically.
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
  /** Outbox rows naming an erased profile that the restore removed. */
  outboxRows: number;
  /** Completed jobs left queued because outbox rows still named an erased profile. */
  outboxDeferred: number;
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

interface JobRow {
  erasure_id: string;
  state: string;
  profile_ids: string[];
}

const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Refuses a restore while an application process is connected to the target database (#1194).
 *
 * The primary gate is the exclusive restore advisory lock: a server process holds it shared for
 * its lifetime, so `am restore` cannot take it even when every pool is idle. This check stays as
 * an extra diagnostic for a process from a build that announces `app.database_application_name`
 * but does not take the shared lock (or one whose lock connection was lost before it exited).
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
 * Workspaces whose restored ledger has publishable keys.
 *
 * `erasure_keys` is under `FORCE ROW LEVEL SECURITY`, so a table owner without `BYPASSRLS` (the
 * small-install case) reads zero rows even though it owns the data, and the restore would clear the
 * fence without contacting ClickHouse (#1194 review). The plain read covers a superuser or a role
 * with `BYPASSRLS`; when it returns nothing, ask the catalog whether RLS is hiding rows:
 *
 * - the same role is the table owner and FORCE is on: lift FORCE for one transaction to read the
 *   distinct workspace ids, then put it back. The app role is never the table owner, so its policy
 *   is enforced throughout; the lift only exempts the owner, which is the restore itself.
 * - the role is neither the owner nor can bypass RLS: refuse instead of silently reconciling
 *   nothing. The caller leaves the fence raised, so no server can start on an unverified point.
 */
async function listRestoredLedgerWorkspaces(pool: pg.Pool): Promise<string[]> {
  const read = (client: Pick<pg.Pool, 'query'>) =>
    client.query<{ id: string }>(`SELECT DISTINCT workspace_id::text AS id FROM erasure_keys WHERE coverage = 'full' ORDER BY 1`);
  const plain = await read(pool);
  if (plain.rows.length) return plain.rows.map((row) => row.id);

  const { rows } = await pool.query<{ forced: boolean; is_owner: boolean; bypass: boolean; role: string }>(
    `SELECT c.relforcerowsecurity AS forced,
            current_user = pg_get_userbyid(c.relowner) AS is_owner,
            (r.rolsuper OR r.rolbypassrls) AS bypass,
            current_user::text AS role
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE n.nspname = 'public' AND c.relname = 'erasure_keys'`,
  );
  const state = rows[0];
  // No ledger table, or a role that can see all rows: the ledger really is empty.
  if (!state || state.bypass || (state.is_owner && !state.forced)) return [];
  if (!state.is_owner)
    throw new Error(
      `the restored erasure ledger is hidden by row-level security from role ${state.role}: it is not the owner of ` +
        'erasure_keys and does not have BYPASSRLS. Run the restore as the table owner or a role with BYPASSRLS; the ' +
        'fence stays raised so no server can start on an unreconciled point.',
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transactional DDL: a rollback restores FORCE, so a crash cannot leave the owner exempt.
    await client.query('ALTER TABLE public.erasure_keys NO FORCE ROW LEVEL SECURITY');
    const ids = await read(client);
    await client.query('ALTER TABLE public.erasure_keys FORCE ROW LEVEL SECURITY');
    await client.query('COMMIT');
    return ids.rows.map((row) => row.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One transaction scoped to a workspace, the way `db.withWorkspace` does it: RLS policies read
 * `app.workspace_id`, so a non-BYPASSRLS owner sees exactly that workspace's ledger and job rows.
 */
async function inWorkspace<T>(pool: pg.Pool, workspaceId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reconciles the restored ledger with ClickHouse and records the confirmation on the jobs. Runs
 * after the final ClickHouse load, before the restore reports success. Throws when the keys cannot
 * be published or confirmed visible, leaving the pending-restore marker in place so the app refuses
 * to serve reads until a restore completes.
 *
 * Everything that reads a tenant table happens inside `inWorkspace`: a restore run as a
 * non-BYPASSRLS owner must still see the restored rows (#1194 review).
 */
export async function reconcileRestoredErasureExclusions(opts: ReconcileRestoreOptions): Promise<ReconcileRestoreResult> {
  const result: ReconcileRestoreResult = {
    workspaces: 0,
    keys: 0,
    inserted: 0,
    batches: 0,
    jobs: 0,
    outboxRows: 0,
    outboxDeferred: 0,
  };
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

    const workspaceIds = await listRestoredLedgerWorkspaces(pool);
    for (const workspaceId of workspaceIds) {
      const { ledger, jobs } = await inWorkspace(pool, workspaceId, async (client) => {
        const ledger = await client.query<LedgerRow>(
          `SELECT workspace_id, erasure_id, kind, key_value, key_version
             FROM erasure_keys
            WHERE coverage = 'full'
            ORDER BY workspace_id, erasure_id, kind, key_value, key_version`,
        );
        const erasureIds = [...new Set(ledger.rows.map((row) => row.erasure_id))];
        const jobs = erasureIds.length
          ? await client.query<JobRow>(
              `SELECT erasure_id, state, profile_ids FROM erasure_cleanup_jobs
                WHERE workspace_id = $1 AND erasure_id = ANY($2::text[])`,
              [workspaceId, erasureIds],
            )
          : undefined;
        return { ledger: ledger.rows, jobs: jobs?.rows ?? [] };
      });
      if (!ledger.length) continue;

      const keys = [...new Set(ledger.map((row) => row.key_value))];
      const erasureIds = [...new Set(ledger.map((row) => row.erasure_id))];
      const existing = await events.erasedSubjectKeys(workspaceId);
      const missing = ledger.filter((row) => !existing.has(row.key_value));
      // A new generation for the whole restored publication: a retry or a later restore can never
      // make the confirmed state regress. Inserting only the missing keys keeps the work bounded by
      // what the ClickHouse point actually lost.
      const generation = await inWorkspace(pool, workspaceId, (client) => nextErasureGeneration({ admin: client }, workspaceId));
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

      const confirmed = await inWorkspace(pool, workspaceId, async (client) => {
        // The cache epoch moves only after the FINAL read; the restored process has no warm cache,
        // but a publication that moved the epoch before its rows were visible is exactly what this
        // rule exists to prevent.
        await noteErasedSubjectsVisible({ admin: client }, workspaceId);

        // A completed job is not reopened for another sweep, so its final worker pass never runs
        // after a restore. Do the outbox half of that pass here: failed and delivered rows can
        // still name the person (a DOI token, a click URL), and a requeue could deliver one after
        // the job says complete. The restore's exclusive lock proves no dispatcher is running, so
        // pending and delivering rows are removed too instead of being waited for, which is what
        // the worker's barrier would do had it not been stopped (#1194 review).
        const clean = new Set<string>();
        let outboxRows = 0;
        let outboxDeferred = 0;
        for (const job of jobs.filter((row) => row.state === 'complete')) {
          outboxRows += await dropErasedProfileOutbox({ admin: client }, workspaceId, job.profile_ids, {
            includeUndelivered: true,
          });
          if ((await erasureOutboxOutstanding({ admin: client }, workspaceId, job.profile_ids)) === 0) clean.add(job.erasure_id);
          else {
            outboxDeferred += 1;
            log(`workspace ${workspaceId}: erasure ${job.erasure_id} stays queued; outbox rows still name its erased profiles`);
          }
        }

        // Only now may the jobs say they published. A finished job whose outbox is clean stays
        // complete and is not queued for another sweep; an unfinished one, or a finished one the
        // outbox still blocks, is made due so its remaining sweep runs. The marker and the
        // confirmed keys are what protect reads in between.
        const published = await client.query(
          `UPDATE erasure_cleanup_jobs
              SET published_generation = $2,
                  published_at = COALESCE(published_at, now()),
                  state = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN state ELSE 'pending_external' END,
                  attempts = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN attempts ELSE 0 END,
                  next_attempt_at = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN next_attempt_at ELSE now() END,
                  claim_token = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN claim_token ELSE NULL END,
                  lease_until = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN lease_until ELSE NULL END,
                  completion_reason = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN completion_reason
                                           WHEN state = 'complete' THEN 'outbox'
                                           ELSE NULL END,
                  last_error = CASE WHEN state = 'complete' AND erasure_id = ANY($4::text[]) THEN last_error ELSE NULL END,
                  updated_at = now()
            WHERE workspace_id = $1 AND erasure_id = ANY($3::text[])`,
          [workspaceId, generation, erasureIds, [...clean]],
        );
        // A restored ClickHouse may carry rows from before a physical purge, so purge progress is not
        // evidence after a load: reset it and let the bounded recurring sweep run again (#1037 part 3).
        await client.query(
          `UPDATE erasure_generations
              SET purged_generation = 0, purge_last_sweep_at = NULL,
                  purge_claim_token = NULL, purge_lease_until = NULL, updated_at = now()
            WHERE workspace_id = $1`,
          [workspaceId],
        );
        return { jobs: published.rowCount ?? 0, outboxRows, outboxDeferred };
      });

      result.workspaces += 1;
      result.keys += keys.length;
      result.inserted += missing.length;
      result.jobs += confirmed.jobs;
      result.outboxRows += confirmed.outboxRows;
      result.outboxDeferred += confirmed.outboxDeferred;
      log(
        `workspace ${workspaceId}: ${keys.length} restored exclusion key(s), ` +
          `${missing.length} re-published under generation ${generation}, ${confirmed.jobs} cleanup job(s) confirmed` +
          (confirmed.outboxRows ? `, ${confirmed.outboxRows} outbox row(s) removed` : ''),
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
 * of racing the first through its marker and ClickHouse load. A running server holds the same lock
 * shared from before its migrations until shutdown, so an app process that is still up refuses the
 * restore even when its pools are idle. The caller must hold it until the fence is cleared.
 */
export async function acquireRestoreSessionLock(databaseUrl: string): Promise<RestoreSessionLock> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
    if (!rows[0]?.locked)
      throw new Error(
        'another restore is running, or an app, worker or scheduler still holds the restore lock. ' +
          'Stop every app, worker and scheduler first, then retry.',
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

/** The lock a server process (or `am migrate`) holds shared for its lifetime (#1194 review). */
export interface RestoreStartupLock {
  /** The dedicated backend's PID, for a log line and for tests. */
  pid: number;
  /** Ends the lock session; its shared lock goes with it. Idempotent. */
  release(): Promise<void>;
}

export interface RestoreStartupLockOptions {
  /**
   * Called once if the lock connection is lost before `release()`. The server exits: a process that
   * can no longer prove the interlock must not serve reads or write through its pools (#1194).
   */
  onLost?: (err: Error) => void;
  /** How long to wait for an active restore to finish before refusing. Default 3 s. */
  waitMs?: number;
}

const RESTORE_STARTUP_WAIT_MS = 3_000;
const RESTORE_STARTUP_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fenceBlockMessage = (fence: RestoreFenceState) =>
  `A restore of ${fence.backup} started at ${fence.startedAt} did not finish reconciling erasure exclusions. ` +
  'Refusing to serve person-linked reads until it does; run `am restore` for that backup again to completion, ' +
  'or `am restore --clear-fence` to abandon it deliberately.';

/**
 * The startup interlock every server role (and `am migrate`) takes before its first migration
 * (#1194 review):
 *
 * 1. `pg_try_advisory_lock_shared` on a dedicated connection, retried for a short wait so a restore
 *    that is just finishing does not fail a start. An exclusive holder (`am restore`) makes this
 *    fail, which is why a restore in progress refuses every process that would race it;
 * 2. the fence row is read **under that lock**, so a restore that raises the fence immediately
 *    afterwards cannot slip between the check and the migrations;
 * 3. the lock and its connection stay until `release()` runs after the workers drain at shutdown.
 *
 * It is a separate `pg.Client`, not a pool member, so it never competes with the app pool's
 * `poolSize` and no idle timeout can return it. `onLost` must stop the process: without the lock a
 * restore could start while this process is still serving.
 */
export async function acquireRestoreStartupLock(databaseUrl: string, opts: RestoreStartupLockOptions = {}): Promise<RestoreStartupLock> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let lockPid = 0;
  try {
    const deadline = Date.now() + Math.max(0, opts.waitMs ?? RESTORE_STARTUP_WAIT_MS);
    let locked = false;
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock_shared($1) AS locked', [
        RESTORE_ADVISORY_LOCK_KEY,
      ]);
      if (rows[0]?.locked) {
        locked = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(RESTORE_STARTUP_POLL_MS);
    }
    if (!locked)
      throw new Error(
        'A restore is running on this database. Stop it or wait for it to finish before starting the app or running migrations.',
      );
    const fence = await restoreFenceState(client);
    if (fence) throw new Error(fenceBlockMessage(fence));
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    lockPid = Number(rows[0]?.pid ?? 0);
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }

  let released = false;
  const lost = (err: Error) => {
    if (!released) opts.onLost?.(err);
  };
  client.on('error', lost);
  client.on('end', () => lost(new Error('the restore lock connection ended unexpectedly')));
  return {
    pid: lockPid,
    async release() {
      if (released) return;
      released = true;
      // Keep the listeners: after this flag they are no-ops, and an error during `end()` must not
      // become an unhandled 'error' event on the client.
      await client.end().catch(() => {});
    },
  };
}

/**
 * The deliberate escape hatch behind `am restore --clear-fence`. It takes the same exclusive lock
 * as a restore first, so it cannot delete the fence of a restore that is still running (or while a
 * server still holds the shared lock). It only removes the fence; the caller has to have decided
 * that the ClickHouse exclusions are correct (or acceptable) already. Returns false when there was
 * no fence to clear.
 */
export async function clearRestoreFenceForUrl(databaseUrl: string): Promise<boolean> {
  const session = await acquireRestoreSessionLock(databaseUrl);
  try {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const before = await restoreFenceState(pool);
      if (!before) return false;
      await clearRestoreFence(pool);
      return true;
    } finally {
      await pool.end().catch(() => {});
    }
  } finally {
    await session.release();
  }
}
