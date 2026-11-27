import { randomUUID } from 'node:crypto';
import {
  APP_DATABASE_APPLICATION_NAME,
  BACKUP_APPLICATION_NAME,
  clearRestoreFence,
  dropErasedProfileOutbox,
  erasureOutboxOutstanding,
  type FenceClient,
  nextErasureGeneration,
  noteErasedSubjectsVisible,
  RESTORE_ADVISORY_LOCK_KEY,
  RESTORE_APPLICATION_NAME,
  type RestoreFenceState,
  raiseRestoreFence,
  restoreFenceState,
  withApplicationName,
  withRestoreAppName,
} from '@agentic-marketing/db';
import { clickHouseStore, type EventStore, type SubjectKeyKind } from '@agentic-marketing/events';
import pg, { type QueryConfig } from 'pg';
import { type ClickHouseEndpoint, clickhouseEndpoint, clickhouseUrl } from './clickhouse-endpoint';

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
 * `public.restore_fence` (written before the replacement, kept out of the list the load restores
 * from, and raised again right after it, because a dump from an older build can carry the table)
 * and the session-level restore lock gone with the process. A server refuses to start while the
 * fence exists; rerunning the same restore clears it after reconciliation (#1194 review).
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
  /**
   * Aborted when the restore loses the exclusive lock (#1204 review). Nothing may be written after
   * that point: another restore may already own the database, and a late write — the fence delete
   * in particular — would land in its run.
   */
  signal?: AbortSignal;
  /**
   * The fence row this attempt raised. With it, `finishRestoreReconciliation` deletes only that row,
   * so a stale attempt cannot clear a newer restore's fence (#1204 review).
   */
  fence?: RestoreFenceState;
  /**
   * The connection that holds the exclusive restore lock. The fence is cleared through it, so a lost
   * session cannot delete a row at all (#1204 review).
   */
  fenceClient?: FenceClient;
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
 * The server's row-policy mode, read the way `config.ts` defaults it. With policies installed and a
 * server that no longer takes `SQL_workspace`, a store built without this mode reads an empty
 * workspace instead of refusing (#1225 review).
 */
function restoreRowPolicies(value: string | undefined): 'required' | 'auto' | 'off' {
  return value === 'required' || value === 'off' ? value : 'auto';
}

/** The error an aborted restore must fail with, whether the signal carried one or not. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('the restore was aborted because its exclusive lock connection was lost');
}

/**
 * Stops a restore between steps once its lock connection is lost (#1204 review). Child processes
 * are killed by the caller; this is the boundary that keeps the restore itself from publishing,
 * cleaning outboxes or clearing the fence after another attempt may own the database.
 */
function assertRestoreNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Refuses a restore while an application process is connected to the target database (#1194).
 *
 * The primary gate is the exclusive restore advisory lock: a server process holds it shared for
 * its lifetime, so `am restore` cannot take it even when every pool is idle. This check stays as
 * an extra diagnostic for a process from a build that announces `app.database_application_name`
 * but does not take the shared lock (or one whose lock connection was lost before it exited).
 */
export async function assertDatabaseDrained(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: withRestoreAppName(databaseUrl) });
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
 * The marker every ClickHouse request a restore issues carries in its `query_id` (#1204 review).
 * The advisory lock only fences the lock session, so a successor finds the predecessor's ClickHouse
 * work in `system.processes` by this prefix before it writes.
 */
export const RESTORE_CLICKHOUSE_QUERY_PREFIX = 'am-restore-';

/** A fresh `query_id` for one ClickHouse request a restore issues. */
export function restoreClickHouseQueryId(): string {
  return `${RESTORE_CLICKHOUSE_QUERY_PREFIX}${randomUUID()}`;
}

/** How long a successor restore waits for a predecessor's tagged work to disappear. */
const RESTORE_WORK_DRAIN_TIMEOUT_MS = 60_000;
const RESTORE_WORK_DRAIN_POLL_MS = 250;
/**
 * The floor for one probe request. A poll that starts with almost no time left still gets a
 * complete round trip instead of a client timeout that would mask the drain's own refusal.
 */
const RESTORE_WORK_PROBE_MIN_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RestoreWorkDrainOptions {
  /** How long to wait before refusing. Default 60 s; tests pass a short bound. */
  timeoutMs?: number;
  /** Delay between polls. Default 250 ms. */
  pollMs?: number;
  /**
   * Backends to ignore. The successor's own lock session announces the restore name too, so the
   * caller passes its PID; the drain's own check connection excludes itself.
   */
  excludePids?: readonly number[];
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** How many ClickHouse requests carrying the restore marker are running right now. */
async function countRunningRestoreClickHouseQueries(endpoint: ClickHouseEndpoint, database: string, timeoutMs: number): Promise<number> {
  const target = new URL(endpoint.url);
  // `system` always exists; the restore's own database is a parameter, so a target database that
  // is fresh or absent does not make the probe fail.
  target.searchParams.set('database', 'system');
  target.searchParams.set('param_db', database);
  // `current_database` is the running query's own database (`system.processes.current_database`).
  // A bare `database` in this statement resolves to the probe's own database — always `system` —
  // so it would never match a restore writing elsewhere (#1204 review).
  target.searchParams.set(
    'query',
    `SELECT count() FROM system.processes WHERE startsWith(query_id, '${RESTORE_CLICKHOUSE_QUERY_PREFIX}') AND current_database = {db:String}`,
  );
  let response: Response;
  const timeout = Math.max(RESTORE_WORK_PROBE_MIN_MS, timeoutMs);
  try {
    // The probe is bounded by the drain's deadline: a ClickHouse that accepted the request and
    // never answers must not hold the restore open (#1204 review).
    response = await fetch(target, { headers: endpoint.headers, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const stalled = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(
      stalled
        ? `could not check ClickHouse for running restore work: the request did not finish within ${timeout} ms. ` +
            'Refusing to start a restore before its ClickHouse work can be seen.'
        : `could not check ClickHouse for running restore work: ${(err as Error).message}. ` +
            'Refusing to start a restore before its ClickHouse work can be seen.',
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000).trim();
    throw new Error(
      `could not check ClickHouse for running restore work (${response.status}): ${detail || response.statusText}. ` +
        'Refusing to start a restore before its ClickHouse work can be seen.',
    );
  }
  let text: string;
  try {
    // The body is part of the same request: a server that sends headers and then stalls is bounded
    // by the same signal.
    text = await response.text();
  } catch (err) {
    const stalled = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(
      stalled
        ? `could not check ClickHouse for running restore work: the response did not finish within ${timeout} ms. ` +
            'Refusing to start a restore before its ClickHouse work can be seen.'
        : `could not check ClickHouse for running restore work: ${(err as Error).message}. ` +
            'Refusing to start a restore before its ClickHouse work can be seen.',
    );
  }
  const count = Number(text.trim());
  if (!Number.isFinite(count)) throw new Error('ClickHouse returned an unreadable count for running restore work');
  return count;
}

/**
 * Waits until the previous restore's work is observably gone (#1204 review).
 *
 * The restore holds its exclusive advisory lock on one dedicated session, but it writes through
 * pools and helper clients (`pg_restore`'s own backend included) and issues ClickHouse TRUNCATEs and
 * inserts. None of that is fenced by the advisory lock: if the predecessor's lock session drops, a
 * successor can take the lock while the predecessor is still writing. So the successor waits — right
 * after taking the lock, before any write — for both of these:
 *
 * - no other backend on this database announces {@link RESTORE_APPLICATION_NAME} or
 *   {@link BACKUP_APPLICATION_NAME}, and
 * - no ClickHouse request carries the {@link RESTORE_CLICKHOUSE_QUERY_PREFIX} marker.
 *
 * A predecessor that notices its own lock loss stops issuing work (the abort signal threaded
 * through its steps), so this normally clears quickly. If it stays busy past the bound, the restore
 * refuses instead of racing it. A running backup is waited for too, with its own message: it would
 * read the database while the restore replaces it, so its snapshot would be incomplete (#1214). Residual limit: a run cut off by a network partition it has not yet
 * noticed can still issue one request after this check; make sure the old `am restore` process has
 * exited before retrying after a lock-loss failure.
 */
export async function assertRestoreWorkDrained(databaseUrl: string, opts: RestoreWorkDrainOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const timeoutMs = Math.max(0, opts.timeoutMs ?? RESTORE_WORK_DRAIN_TIMEOUT_MS);
  const pollMs = Math.max(1, opts.pollMs ?? RESTORE_WORK_DRAIN_POLL_MS);
  const exclude = [...(opts.excludePids ?? [])];
  // Resolved the way the ClickHouse load and the reconciliation resolve it, so a deployment
  // without `CLICKHOUSE_URL` still probes the default endpoint they write to (#1204 review). The
  // probe itself is sent **without** the restore marker, so it cannot count its own query.
  const endpoint: ClickHouseEndpoint = clickhouseEndpoint(env.CLICKHOUSE_URL);
  const clickhouseDatabase = env.CLICKHOUSE_DATABASE?.trim() || 'am';
  const deadline = Date.now() + timeoutMs;
  // The probe announces the same name as the restore, so it is on the list of connections a later
  // successor waits for; `pid <> pg_backend_pid()` keeps it from counting itself here. The
  // connection gets the whole bound; each poll below gets the part still left (#1204 review).
  const client = new pg.Client({
    connectionString: withRestoreAppName(databaseUrl),
    connectionTimeoutMillis: Math.max(RESTORE_WORK_PROBE_MIN_MS, timeoutMs),
  });
  await client.connect();
  try {
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const { rows } = await client.query<{ name: string; n: number | string }>({
        text: `SELECT application_name AS name, count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = ANY($1::text[])
            AND pid <> pg_backend_pid()
            AND NOT (pid = ANY($2::int[]))
          GROUP BY application_name`,
        values: [[RESTORE_APPLICATION_NAME, BACKUP_APPLICATION_NAME], exclude],
        // node-postgres reads a per-query `query_timeout` at runtime; its types only declare the
        // client option, hence the cast. A hung poll still ends at the drain's bound.
        query_timeout: Math.max(RESTORE_WORK_PROBE_MIN_MS, remaining),
      } as QueryConfig & { query_timeout: number });
      const countOf = (name: string) => Number(rows.find((row) => row.name === name)?.n ?? 0);
      const backends = countOf(RESTORE_APPLICATION_NAME);
      const backups = countOf(BACKUP_APPLICATION_NAME);
      const queries = await countRunningRestoreClickHouseQueries(endpoint, clickhouseDatabase, Math.max(1, deadline - Date.now()));
      if (backends === 0 && backups === 0 && queries === 0) return;
      if (Date.now() >= deadline) {
        // A running backup reads the database this restore replaces; its snapshot would be
        // incomplete. Say so instead of calling it a previous restore (#1214).
        if (backends === 0 && queries === 0)
          throw new Error(
            `a backup is still running (${backups} PostgreSQL connection(s) still tagged ${BACKUP_APPLICATION_NAME}): ` +
              'a restore would replace the database while it reads, so the backup would be incomplete. Wait for it to finish and retry.',
          );
        throw new Error(
          `a previous restore's work is still running (${backends} PostgreSQL connection(s)` +
            `${queries ? `, ${queries} ClickHouse request(s)` : ''} still tagged ${RESTORE_APPLICATION_NAME}` +
            `${backups ? `, ${backups} backup connection(s) still tagged ${BACKUP_APPLICATION_NAME}` : ''}): ` +
            'it could still write into the database this restore is about to replace, so this restore refuses to start. ' +
            'Wait until that run has stopped and retry.',
        );
      }
      // While it waits, say what it is waiting for: a drain held open by a backup alone names the
      // backup, not a previous restore (#1214 review).
      opts.log?.(
        backends === 0 && queries === 0
          ? `waiting for a running backup to stop (${backups} PostgreSQL connection(s) still tagged ${BACKUP_APPLICATION_NAME})`
          : `waiting for a previous restore's work to stop (${backends} PostgreSQL connection(s)` +
              `${backups ? `, ${backups} backup connection(s)` : ''}, ${queries} ClickHouse request(s))`,
      );
      await sleep(pollMs);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Workspaces whose restored table holds rows matching `where`.
 *
 * `erasure_keys` and `erasure_cleanup_jobs` are under `FORCE ROW LEVEL SECURITY`, so a table owner
 * without `BYPASSRLS` (the small-install case) reads zero rows even though it owns the data, and the
 * restore would clear the fence without contacting ClickHouse (#1194 review). The plain read covers
 * a superuser or a role with `BYPASSRLS`; when it returns nothing, ask the catalog whether RLS is
 * hiding rows:
 *
 * - the same role is the table owner and FORCE is on: lift FORCE for one transaction to read the
 *   distinct workspace ids, then put it back. The app role is never the table owner, so its policy
 *   is enforced throughout; the lift only exempts the owner, which is the restore itself.
 * - the role is neither the owner nor can bypass RLS: refuse instead of silently reconciling
 *   nothing. The caller leaves the fence raised, so no server can start on an unverified point.
 *
 * A superuser or `BYPASSRLS` role sees every workspace's rows at once, so the scan itself is not
 * tenant-scoped: every query that follows must name its workspace (#1204 review).
 */
async function listRestoredWorkspaces(pool: pg.Pool, table: string, where: string): Promise<string[]> {
  const read = (client: Pick<pg.Pool, 'query'>) =>
    client.query<{ id: string }>(`SELECT DISTINCT workspace_id::text AS id FROM ${table} WHERE ${where} ORDER BY 1`);
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
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [table],
  );
  const state = rows[0];
  // No such table, or a role that can see all rows: the table really is empty.
  if (!state || state.bypass || (state.is_owner && !state.forced)) return [];
  if (!state.is_owner)
    throw new Error(
      `the restored ${table} is hidden by row-level security from role ${state.role}: it is not the owner of ` +
        `${table} and does not have BYPASSRLS. Run the restore as the table owner or a role with BYPASSRLS; the ` +
        'fence stays raised so no server can start on an unreconciled point.',
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transactional DDL: a rollback restores FORCE, so a crash cannot leave the owner exempt.
    await client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
    const ids = await read(client);
    await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
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
  const pool = new pg.Pool({ connectionString: withRestoreAppName(opts.databaseUrl), max: 2 });
  const env = opts.env ?? process.env;
  const signal = opts.signal;
  const store =
    opts.events === undefined
      ? clickHouseStore({
          // The same resolved endpoint (`CLICKHOUSE_URL` or its default) the drain probes.
          url: clickhouseUrl(env.CLICKHOUSE_URL),
          database: env.CLICKHOUSE_DATABASE?.trim() || 'am',
          rowPolicies: restoreRowPolicies(env.CLICKHOUSE_ROW_POLICIES),
          // Every exclusion read and publication this store issues is tagged, so a successor's
          // drain finds it in `system.processes` (#1204 review).
          queryIdPrefix: RESTORE_CLICKHOUSE_QUERY_PREFIX,
          ...(signal ? { signal } : {}),
        })
      : undefined;
  const events = opts.events ?? store!;
  try {
    assertRestoreNotAborted(signal);
    // The durable ledger arrived in 0.17.0 (#1204 review): a snapshot from before it has no
    // `erasure_keys`, so there is nothing to publish. `erasure_cleanup_jobs` came earlier, and a
    // completed job from such a snapshot still has an outbox pass to run — its rows name a person
    // whose erasure is complete. Gate only the publication on the ledger.
    const tables = await pool.query<{ keys: boolean; jobs: boolean }>(
      "SELECT to_regclass('public.erasure_keys') IS NOT NULL AS keys, to_regclass('public.erasure_cleanup_jobs') IS NOT NULL AS jobs",
    );
    const hasLedger = tables.rows[0]?.keys ?? false;
    if (!tables.rows[0]?.jobs) return result;

    const workspaceIds = [
      ...new Set([
        ...(hasLedger ? await listRestoredWorkspaces(pool, 'erasure_keys', "coverage = 'full'") : []),
        // A completed job with no publishable key at all (a generation-0 publication, or one from
        // before the durable ledger) still has to clean its erased profiles' outbox rows (#1204
        // review), so its workspace is visited even though there is nothing to publish.
        ...(await listRestoredWorkspaces(pool, 'erasure_cleanup_jobs', "state = 'complete'")),
      ]),
    ].sort();
    for (const workspaceId of workspaceIds) {
      assertRestoreNotAborted(signal);
      const { ledger, jobs } = await inWorkspace(pool, workspaceId, async (client) => {
        // The workspace predicate is explicit: a restore commonly runs as a superuser or a
        // BYPASSRLS role, and `app.workspace_id` alone would then hand this workspace every other
        // workspace's keys (#1204 review).
        const ledger = hasLedger
          ? (
              await client.query<LedgerRow>(
                `SELECT workspace_id, erasure_id, kind, key_value, key_version
                   FROM erasure_keys
                  WHERE workspace_id = $1 AND coverage = 'full'
                  ORDER BY workspace_id, erasure_id, kind, key_value, key_version`,
                [workspaceId],
              )
            ).rows
          : [];
        const erasureIds = [...new Set(ledger.map((row) => row.erasure_id))];
        // Every completed job needs its final outbox pass, whether or not it has a key to publish;
        // an unfinished one needs it only to record its publication.
        const jobs = await client.query<JobRow>(
          `SELECT erasure_id, state, profile_ids FROM erasure_cleanup_jobs
            WHERE workspace_id = $1 AND (state = 'complete' OR erasure_id = ANY($2::text[]))
            ORDER BY erasure_id`,
          [workspaceId, erasureIds],
        );
        return { ledger, jobs: jobs.rows };
      });

      const keys = [...new Set(ledger.map((row) => row.key_value))];
      const erasureIds = [...new Set(ledger.map((row) => row.erasure_id))];
      let missing: LedgerRow[] = [];
      let generation: number | null = null;
      if (keys.length) {
        // Every publication is a write; after a lost lock another restore may own the database.
        assertRestoreNotAborted(signal);
        const existing = await events.erasedSubjectKeys(workspaceId);
        missing = ledger.filter((row) => !existing.has(row.key_value));
        // A new generation for the whole restored publication: a retry or a later restore can never
        // make the confirmed state regress. Inserting only the missing keys keeps the work bounded by
        // what the ClickHouse point actually lost.
        assertRestoreNotAborted(signal);
        const publishGeneration = await inWorkspace(pool, workspaceId, (client) => nextErasureGeneration({ admin: client }, workspaceId));
        generation = publishGeneration;
        const recordedAt = new Date().toISOString();
        for (let offset = 0; offset < missing.length; offset += batchSize) {
          assertRestoreNotAborted(signal);
          const batch = missing.slice(offset, offset + batchSize);
          await events.publishErasedSubjects(
            batch.map((row) => ({
              workspaceId,
              kind: row.kind as SubjectKeyKind,
              key: row.key_value,
              keyVersion: row.key_version,
              erasureId: row.erasure_id,
              generation: publishGeneration,
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
          // A read is a request too: the installed client sends even with an already-aborted
          // signal, so check before each chunk (#1204 review).
          assertRestoreNotAborted(signal);
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
      }

      const confirmed = await inWorkspace(pool, workspaceId, async (client) => {
        assertRestoreNotAborted(signal);
        // A completed job is not reopened for another sweep, so its final worker pass never runs
        // after a restore. Do the outbox half of that pass here: failed and delivered rows can
        // still name the person (a DOI token, a click URL), and a requeue could deliver one after
        // the job says complete. The restore's exclusive lock proves no dispatcher is running, so
        // pending and delivering rows are removed too instead of being waited for, which is what
        // the worker's barrier would do had it not been stopped (#1194 review). This runs for every
        // completed job: one whose erasure has no publishable key still has an outbox to clean
        // (#1204 review).
        const clean = new Set<string>();
        let outboxRows = 0;
        let outboxDeferred = 0;
        for (const job of jobs.filter((row) => row.state === 'complete')) {
          // Each job's outbox pass is a write: after a lost lock another restore may own the
          // database, so check before every job, not only before the whole transaction (#1204).
          assertRestoreNotAborted(signal);
          outboxRows += await dropErasedProfileOutbox({ admin: client }, workspaceId, job.profile_ids, {
            includeUndelivered: true,
          });
          if ((await erasureOutboxOutstanding({ admin: client }, workspaceId, job.profile_ids)) === 0) clean.add(job.erasure_id);
          else {
            outboxDeferred += 1;
            log(`workspace ${workspaceId}: erasure ${job.erasure_id} stays queued; outbox rows still name its erased profiles`);
          }
        }

        if (generation === null) return { jobs: 0, outboxRows, outboxDeferred };

        assertRestoreNotAborted(signal);
        // The cache epoch moves only after the FINAL read; the restored process has no warm cache,
        // but a publication that moved the epoch before its rows were visible is exactly what this
        // rule exists to prevent.
        await noteErasedSubjectsVisible({ admin: client }, workspaceId);

        assertRestoreNotAborted(signal);
        // Only now may the jobs say they published. A finished job whose outbox is clean stays
        // complete and is not queued for another sweep; an unfinished one, or a finished one the
        // outbox still blocks, is made due so its remaining sweep runs. The marker and the
        // confirmed keys are what protect reads in between. A completed job with no publishable key
        // is not in `erasureIds`, so it keeps its state and its publication record untouched.
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
        assertRestoreNotAborted(signal);
        await client.query(
          `UPDATE erasure_generations
              SET purged_generation = 0, purge_last_sweep_at = NULL,
                  purge_claim_token = NULL, purge_lease_until = NULL, updated_at = now()
            WHERE workspace_id = $1`,
          [workspaceId],
        );
        return { jobs: published.rowCount ?? 0, outboxRows, outboxDeferred };
      });

      if (keys.length) {
        result.workspaces += 1;
        result.keys += keys.length;
        result.inserted += missing.length;
      }
      result.jobs += confirmed.jobs;
      result.outboxRows += confirmed.outboxRows;
      result.outboxDeferred += confirmed.outboxDeferred;
      if (keys.length)
        log(
          `workspace ${workspaceId}: ${keys.length} restored exclusion key(s), ` +
            `${missing.length} re-published under generation ${generation}, ${confirmed.jobs} cleanup job(s) confirmed` +
            (confirmed.outboxRows ? `, ${confirmed.outboxRows} outbox row(s) removed` : ''),
        );
      else if (confirmed.outboxRows || confirmed.outboxDeferred)
        log(
          `workspace ${workspaceId}: no publishable restored key, ${confirmed.outboxRows} outbox row(s) removed` +
            (confirmed.outboxDeferred ? `, ${confirmed.outboxDeferred} completed job(s) left queued for the outbox` : ''),
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
 *
 * The fence is cleared through the connection that holds the exclusive lock, and only when it still
 * carries this attempt's row (#1204 review): if that connection was lost, another restore may have
 * raised its own fence, and this attempt must not clear it.
 */
export async function finishRestoreReconciliation(opts: ReconcileRestoreOptions): Promise<ReconcileRestoreResult> {
  const result = await reconcileRestoredErasureExclusions(opts);
  assertRestoreNotAborted(opts.signal);
  if (opts.fenceClient) {
    await clearRestoreFence(opts.fenceClient, opts.fence);
    return result;
  }
  const pool = new pg.Pool({ connectionString: withRestoreAppName(opts.databaseUrl), max: 1 });
  try {
    assertRestoreNotAborted(opts.signal);
    await clearRestoreFence(pool, opts.fence);
  } finally {
    await pool.end().catch(() => {});
  }
  return result;
}

/**
 * Raises the fence before anything replaces Postgres (#1194). A `pg_restore` that commits and then
 * fails leaves it behind — and the restore raises it again after the load, because a dump from an
 * older build can carry the table and `--clean` can drop or replace the row. A retry overwrites it
 * and a server started in between refuses to serve reads. It is deliberately not cleared on failure:
 * only reconciliation (or the explicit `am restore --clear-fence`) may remove it.
 *
 * `client` is the session that holds the exclusive restore lock, so a lost session cannot write a
 * fence for a restore that no longer holds the interlock. Returns the row this attempt raised, which
 * reconciliation then has to match before clearing it (#1204 review).
 */
export async function markRestoreStarted(
  client: FenceClient,
  backup: string,
  startedAt = new Date().toISOString(),
): Promise<RestoreFenceState> {
  const state: RestoreFenceState = { backup, startedAt };
  await raiseRestoreFence(client, state);
  return state;
}

/** The advisory lock a restore holds on one dedicated session for its whole run. */
export interface RestoreSessionLock {
  /**
   * The locked connection itself. Fence writes go through it so they cannot outlive the lock
   * (#1204 review); it must not be used after `release()`.
   */
  readonly client: Pick<pg.Client, 'query'>;
  /** The backend PID holding the lock, so a successor's drain can leave its own session out. */
  readonly pid: number;
  release(): Promise<void>;
}

export interface RestoreSessionLockOptions {
  /**
   * Called once if the lock connection is lost before `release()`. The restore no longer holds the
   * interlock — another restore may take it — so the caller must stop the work it started, children
   * included, and fail (#1204 review).
   */
  onLost?: (err: Error) => void;
  /**
   * How long to retry while a backup holds the shared key. The backup keeps it for its whole
   * capture, so a restore that arrives first waits for it, naming the backup, instead of failing
   * with the generic message (#1214). Default 60 s; a running app or another restore still refuses
   * at once, as before.
   */
  waitMs?: number;
  /** Reports what a waiting restore is waiting for. */
  log?: (message: string) => void;
  /** TCP keepalive after this much idle time. Default 10 s; 0 keeps the platform default. */
  keepAliveInitialDelayMs?: number;
  /** How often the session proves it still answers with `SELECT 1`. Default 30 s; 0 disables it. */
  livenessMs?: number;
  /** How long one statement on the lock session may take before it counts as lost. Default 15 s. */
  livenessTimeoutMs?: number;
}

/** TCP keepalive after this much idle time, so a peer that vanished without a FIN is probed. */
const RESTORE_LOCK_KEEPALIVE_MS = 10_000;
/** How often a lock session proves it still answers. */
const RESTORE_LOCK_LIVENESS_MS = 30_000;
/** How long a statement on the lock session may take; also bounds one liveness check. */
const RESTORE_LOCK_LIVENESS_TIMEOUT_MS = 15_000;
/** Delay between retries of the exclusive lock while a backup holds the shared one. */
const RESTORE_LOCK_POLL_MS = 100;

/**
 * The dedicated connection a lock is held on (#1222). `keepAlive` makes the OS probe an idle peer:
 * without it, a peer that drops the connection without a FIN is never noticed, and the holder keeps
 * serving (or restoring) as if its lock were still there. The liveness query's timeout is applied
 * per probe by `watchRestoreLock`, not as a client-wide `query_timeout`: pg arms that timeout when a
 * statement is submitted, so it would also abort a legitimate slow fence statement and would start
 * ticking for a probe that is still queued behind foreground work.
 */
function restoreLockClient(connectionString: string, opts: { keepAliveInitialDelayMs?: number }): pg.Client {
  return new pg.Client({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: opts.keepAliveInitialDelayMs ?? RESTORE_LOCK_KEEPALIVE_MS,
  });
}

/** The lock session's statements, serialised with the liveness probes. */
interface WatchedRestoreLock {
  /** A `query` that queues behind any statement already running or queued on the session. */
  client: Pick<pg.Client, 'query'>;
  /** Stops the heartbeat; idempotent. */
  stop(): void;
}

/**
 * Serialises every statement on the lock session and proves periodically that it still answers
 * (#1222 review). The fence writes share this session, and pg arms a statement's timeout when it is
 * submitted: a probe queued behind a slow fence query would therefore time out while the lock is
 * still healthy and report a false loss. Probes now join the same queue, run only when the session
 * is idle, and start their timeout only once the probe itself executes. A probe that does not
 * answer within `livenessTimeoutMs` is a lost session and runs the existing lock-loss path.
 */
function watchRestoreLock(
  client: pg.Client,
  lost: (err: Error) => void,
  livenessMs: number | undefined,
  livenessTimeoutMs: number,
): WatchedRestoreLock {
  let tail: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let stopped = false;

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    inFlight += 1;
    const result = tail.then(fn, fn);
    tail = result.then(
      () => {
        inFlight -= 1;
      },
      () => {
        inFlight -= 1;
      },
    );
    return result;
  }

  const query = ((text: string, values?: unknown[]) => enqueue(() => client.query(text, values as never))) as unknown as Pick<
    pg.Client,
    'query'
  >['query'];

  async function probeOnce(): Promise<Error | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the restore lock session did not answer its liveness check')), livenessTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([client.query('SELECT 1'), timeout]);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const ms = livenessMs ?? RESTORE_LOCK_LIVENESS_MS;
  const timer =
    ms > 0
      ? setInterval(() => {
          // The idle check and the enqueue happen in one turn, so no foreground statement can slip
          // between them and end up behind the probe.
          if (stopped || inFlight > 0) return;
          void enqueue(probeOnce).then((err) => {
            if (err) lost(err);
          });
        }, ms)
      : undefined;
  // The probe must not keep a shutting-down process alive on its own.
  timer?.unref?.();
  return {
    client: { query },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

/**
 * Takes the exclusive restore advisory lock (#1194). It is session state, not data, so it survives
 * `pg_restore`; a second restore — even one restoring another backup directory — is refused instead
 * of racing the first through its marker and ClickHouse load. A running server holds the same lock
 * shared from before its migrations until shutdown, so an app process that is still up refuses the
 * restore even when its pools are idle. The caller must hold it until the fence is cleared.
 *
 * Losing the connection loses the lock. `onLost` lets the restore stop its spawned children before
 * it exits, instead of leaving a `pg_restore` writing into a database another restore may own
 * (#1204 review).
 */
export async function acquireRestoreSessionLock(databaseUrl: string, opts: RestoreSessionLockOptions = {}): Promise<RestoreSessionLock> {
  // The lock session announces the restore name too: a successor's drain must see it, and excludes
  // it by PID while this attempt is the successor (#1204 review).
  const client = restoreLockClient(withRestoreAppName(databaseUrl), opts);
  await client.connect();
  let pid = 0;
  try {
    // A backup holds the same key shared for its whole capture, so the exclusive take fails while
    // it runs. Retry for the drain bound and name the backup; anything else holding the key (a
    // running app, another restore) still refuses at once, as it did before.
    const deadline = Date.now() + Math.max(0, opts.waitMs ?? RESTORE_WORK_DRAIN_TIMEOUT_MS);
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
      if (rows[0]?.locked) break;
      const { rows: tagged } = await client.query<{ restores: number | string; backups: number | string }>(
        `SELECT count(*) FILTER (WHERE application_name = $1)::int AS restores,
                count(*) FILTER (WHERE application_name = $2)::int AS backups
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND application_name = ANY($3::text[])`,
        [RESTORE_APPLICATION_NAME, BACKUP_APPLICATION_NAME, [RESTORE_APPLICATION_NAME, BACKUP_APPLICATION_NAME]],
      );
      const restores = Number(tagged[0]?.restores ?? 0);
      const backups = Number(tagged[0]?.backups ?? 0);
      if (backups === 0 || restores > 0)
        throw new Error(
          'another restore is running, or an app, worker or scheduler still holds the restore lock. ' +
            'Stop every app, worker and scheduler first, then retry.',
        );
      if (Date.now() >= deadline)
        throw new Error(
          `a backup is still running (${backups} PostgreSQL connection(s) still tagged ${BACKUP_APPLICATION_NAME}): ` +
            'a restore would replace the database while it reads, so the backup would be incomplete. Wait for it to finish and retry.',
        );
      opts.log?.(`waiting for a running backup to stop (${backups} PostgreSQL connection(s) still tagged ${BACKUP_APPLICATION_NAME})`);
      await sleep(RESTORE_LOCK_POLL_MS);
    }
    const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    pid = Number(backend.rows[0]?.pid ?? 0);
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  let released = false;
  let lostReported = false;
  const lost = (err: Error) => {
    if (released || lostReported) return;
    lostReported = true;
    opts.onLost?.(err);
  };
  // Keep a listener on both events: pg emits 'error' when the backend is terminated, and without
  // one Node would treat it as an unhandled error and exit without the caller's cleanup.
  client.on('error', lost);
  client.on('end', () => lost(new Error('the restore lock connection ended unexpectedly')));
  const watch = watchRestoreLock(client, lost, opts.livenessMs, opts.livenessTimeoutMs ?? RESTORE_LOCK_LIVENESS_TIMEOUT_MS);
  return {
    client: watch.client,
    pid,
    async release() {
      released = true;
      watch.stop();
      // A lost session cannot answer, and the server drops its lock with the connection; sending
      // the unlock would only queue behind the unanswered liveness query.
      if (!lostReported) await watch.client.query('SELECT pg_advisory_unlock($1)', [RESTORE_ADVISORY_LOCK_KEY]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * The shared lock a backup holds for its whole capture (#1214 follow-up). `am restore` takes the
 * same key exclusively, so a restore cannot pass its drain check and raise the fence between the
 * backup's fence read and its dump, and it cannot truncate ClickHouse while the export reads it.
 * Backups do not block each other: their shared takes are compatible. The session announces
 * {@link BACKUP_APPLICATION_NAME}, so a restore that arrives while a backup runs names the backup.
 */
export interface BackupInterlock {
  /** The backend PID holding the shared lock, for a test and for a diagnostic. */
  readonly pid: number;
  /**
   * Throws when the interlock was lost. Call it between capture steps and before publishing: a
   * backup that can no longer prove the interlock must not leave an archive behind.
   */
  assertHeld(): void;
  /** Ends the lock session; its shared lock goes with it. */
  release(): Promise<void>;
}

export interface BackupInterlockOptions {
  /** Called once if the lock connection is lost before `release()`. */
  onLost?: (err: Error) => void;
  /** TCP keepalive after this much idle time. Default 10 s. */
  keepAliveInitialDelayMs?: number;
  /** How often the session proves it still answers with `SELECT 1`. Default 30 s; 0 disables it. */
  livenessMs?: number;
  /** How long one statement on the lock session may take before it counts as lost. Default 15 s. */
  livenessTimeoutMs?: number;
}

/**
 * Takes the restore key in shared mode for a backup's whole capture. A restore that already holds it
 * exclusively — or `am restore --clear-fence` — makes this refuse before anything is read. The
 * caller keeps it until the archive and manifest are published; a lost session is reported through
 * `assertHeld` and must discard the partial output.
 */
export async function acquireBackupInterlock(databaseUrl: string, opts: BackupInterlockOptions = {}): Promise<BackupInterlock> {
  const client = restoreLockClient(withApplicationName(databaseUrl, BACKUP_APPLICATION_NAME), opts);
  await client.connect();
  let pid = 0;
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock_shared($1) AS locked', [
      RESTORE_ADVISORY_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) {
      // The exclusive holder is a restore. Name it when it announces itself, so the operator knows
      // to wait rather than to look for a leaked advisory lock.
      const { rows: tagged } = await client.query<{ restores: number | string }>(
        `SELECT count(*)::int AS restores FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = $1`,
        [RESTORE_APPLICATION_NAME],
      );
      throw new Error(
        Number(tagged[0]?.restores ?? 0) > 0
          ? 'A restore is running on this database, so a backup must not read it. Wait for `am restore` to finish, then retry.'
          : 'another process holds the restore lock. Wait for it to finish, then retry.',
      );
    }
    const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    pid = Number(backend.rows[0]?.pid ?? 0);
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  let released = false;
  let lost: Error | undefined;
  let lostReported = false;
  const reportLost = (err: Error) => {
    if (released || lostReported) return;
    lostReported = true;
    lost = err;
    opts.onLost?.(err);
  };
  client.on('error', reportLost);
  client.on('end', () => reportLost(new Error('the backup lock connection ended unexpectedly')));
  const watch = watchRestoreLock(client, reportLost, opts.livenessMs, opts.livenessTimeoutMs ?? RESTORE_LOCK_LIVENESS_TIMEOUT_MS);
  return {
    pid,
    assertHeld() {
      if (lost) throw new Error(`the backup lock was lost before the capture finished, so this backup was discarded: ${lost.message}`);
    },
    async release() {
      if (released) return;
      released = true;
      watch.stop();
      // The shared lock belongs to the session; ending it is enough, and a lost session cannot answer.
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
  /** TCP keepalive after this much idle time. Default 10 s. */
  keepAliveInitialDelayMs?: number;
  /** How often the held lock proves it still answers with `SELECT 1`. Default 30 s; 0 disables it. */
  livenessMs?: number;
  /** How long one statement on the lock session may take before it counts as lost. Default 15 s. */
  livenessTimeoutMs?: number;
}

const RESTORE_STARTUP_WAIT_MS = 3_000;
const RESTORE_STARTUP_POLL_MS = 100;

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
  const client = restoreLockClient(databaseUrl, opts);
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
  let lostReported = false;
  const lost = (err: Error) => {
    if (released || lostReported) return;
    lostReported = true;
    opts.onLost?.(err);
  };
  client.on('error', lost);
  client.on('end', () => lost(new Error('the restore lock connection ended unexpectedly')));
  const watch = watchRestoreLock(client, lost, opts.livenessMs, opts.livenessTimeoutMs ?? RESTORE_LOCK_LIVENESS_TIMEOUT_MS);
  return {
    pid: lockPid,
    async release() {
      if (released) return;
      released = true;
      watch.stop();
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
export async function clearRestoreFenceForUrl(databaseUrl: string, opts: RestoreWorkDrainOptions = {}): Promise<boolean> {
  const session = await acquireRestoreSessionLock(databaseUrl);
  try {
    // A previous restore's work is drained here too: the fence may be cleared only once no other
    // tagged connection or ClickHouse request could still write into this database (#1204 review).
    await assertRestoreWorkDrained(databaseUrl, { ...opts, excludePids: [...(opts.excludePids ?? []), session.pid] });
    // Both the read and the delete go through the locked session, so the escape hatch cannot clear
    // a fence after losing the interlock it was granted under (#1204 review).
    const before = await restoreFenceState(session.client);
    if (!before) return false;
    await clearRestoreFence(session.client);
    return true;
  } finally {
    await session.release();
  }
}
