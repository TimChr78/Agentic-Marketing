import pg from 'pg';
import { migrate } from './migrate';

// Erasures live in the database they protect, so a restore from a snapshot taken before an
// erasure would bring the erased person back (#144). `am restore` reads this log from the live
// database before replacing it and replays it afterwards: profiles and identifiers named by an
// erasure are deleted again, their suppression hashes are restored and the keyed tombstones go
// back, so late events cannot recreate the person either. Only hashes are involved; no plaintext
// personal data is copied by the replay.

export interface ErasureRecord {
  workspaceId: string;
  id: string;
  profileIds: string[];
  requestedBy: string;
  reason: string;
  counts: Record<string, number>;
  at: string;
  /**
   * User and anonymous ids the live database had captured when the erasure was recorded (#373).
   * Absent when the live log predates warehouse key tracking, so absence must not be read as a
   * known zero. Replay keeps the larger of this count and the keys it recaptures from the restored
   * snapshot, so later key pruning is never mistaken for a person who never had event-capable ids
   * (#421).
   */
  warehouseKeyCount?: number;
}

export interface ErasureTombstoneRecord {
  workspaceId: string;
  identHash: string;
  erasedAt: string;
  erasureId: string;
}

/**
 * One erasure's cleanup job, carried through a restore so the restored database cleans the
 * external stores again. The selectors keep the sealing they already have (a per-erasure service
 * key wrapped by the KEK), so the replay never needs to read or reseal personal data.
 */
export interface ErasureCleanupJobRecord {
  workspaceId: string;
  erasureId: string;
  profileIds: string[];
  /** The live job's state, so a restore can keep an unfinished job over a completed one. */
  state: string;
  clickhouseDone: boolean;
  hotstateDone: boolean;
  selectors: Buffer | null;
  selectorKey: Buffer | null;
  selectorKek: string | null;
}

export interface ErasureLog {
  erasures: ErasureRecord[];
  tombstones: ErasureTombstoneRecord[];
  /** Pending cleanup jobs for the erasures above; absent from a database older than 0.15.0. */
  cleanupJobs?: ErasureCleanupJobRecord[];
}

export interface ReplayErasuresResult {
  /** Workspaces whose erasures were replayed. */
  workspaces: number;
  /** Erasure rows re-inserted into the restored database. */
  erasures: number;
  /** Profiles the restored snapshot held although they had been erased. */
  profiles: number;
  /** Tombstones re-inserted (or refreshed). */
  tombstones: number;
  /** Pending cleanup jobs recreated for the replayed erasures. */
  cleanupJobs: number;
  /** Entries for workspaces the restored snapshot no longer has; nothing to erase there. */
  skipped: number;
}

export interface ReplayErasuresOptions {
  log?: (message: string) => void;
}

async function withClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function hasTable(client: pg.Client, name: string): Promise<boolean> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return rows.length > 0;
}

async function hasColumn(client: pg.Client, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * Reads every erasure and tombstone from a live database. A database older than 0.3.0 has
 * neither table; it then has no erasures to replay. Throws when the log cannot be read, because
 * restoring without it could resurrect people.
 */
export async function readErasureLog(databaseUrl: string): Promise<ErasureLog> {
  return withClient(databaseUrl, async (client) => {
    const erasuresTable = await hasTable(client, 'erasures');
    const erasuresHaveKeyCount = erasuresTable && (await hasColumn(client, 'erasures', 'warehouse_key_count'));
    const keysPresent = erasuresHaveKeyCount && (await hasTable(client, 'warehouse_erasure_keys'));
    // A pre-0068 erasure was given the column's default of zero by the migration, not by a real
    // capture. Reading the tracking start lets the log tell that unknown legacy coverage apart from
    // a known zero, so replay does not turn "we cannot know" into "there was nothing" (#421).
    let trackingSince: string | undefined;
    if (erasuresHaveKeyCount && (await hasTable(client, 'warehouse_erasure_key_tracking'))) {
      const { rows } = await client.query<{ since: Date | string }>('SELECT since FROM warehouse_erasure_key_tracking LIMIT 1');
      if (rows[0]) trackingSince = iso(rows[0].since);
    }
    const erasures = erasuresTable
      ? (
          await client.query<{
            workspace_id: string;
            id: string;
            profile_ids: string[];
            requested_by: string;
            reason: string;
            counts: Record<string, number>;
            at: Date | string;
            warehouse_key_count?: number | string | null;
          }>(
            `SELECT workspace_id, id, profile_ids, requested_by, reason, counts, at${
              erasuresHaveKeyCount
                ? keysPresent
                  ? `, CASE WHEN warehouse_key_count = 0 THEN GREATEST(warehouse_key_count,
                (SELECT count(*)::integer FROM warehouse_erasure_keys k WHERE k.workspace_id = e.workspace_id
                 AND k.profile_id = ANY(e.profile_ids))) ELSE warehouse_key_count END AS warehouse_key_count`
                  : ', warehouse_key_count'
                : ''
            } FROM erasures e`,
          )
        ).rows.map((row) => {
          const at = iso(row.at);
          const known =
            erasuresHaveKeyCount &&
            row.warehouse_key_count !== undefined &&
            row.warehouse_key_count !== null &&
            Number(row.warehouse_key_count) >= 0 &&
            trackingSince !== undefined &&
            Date.parse(at) >= Date.parse(trackingSince)
              ? Number(row.warehouse_key_count)
              : undefined;
          return {
            workspaceId: row.workspace_id,
            id: row.id,
            profileIds: row.profile_ids,
            requestedBy: row.requested_by,
            reason: row.reason,
            counts: row.counts,
            at,
            ...(known === undefined ? {} : { warehouseKeyCount: known }),
          };
        })
      : [];
    const tombstones = (await hasTable(client, 'erasure_tombstones'))
      ? (
          await client.query<{ workspace_id: string; ident_hash: string; erased_at: Date | string; erasure_id: string }>(
            'SELECT workspace_id, ident_hash, erased_at, erasure_id FROM erasure_tombstones',
          )
        ).rows.map((row) => ({
          workspaceId: row.workspace_id,
          identHash: row.ident_hash,
          erasedAt: iso(row.erased_at),
          erasureId: row.erasure_id,
        }))
      : [];
    const cleanupJobs = (await hasTable(client, 'erasure_cleanup_jobs'))
      ? (
          await client.query<{
            workspace_id: string;
            erasure_id: string;
            profile_ids: string[];
            state: string;
            clickhouse_done: boolean;
            hotstate_done: boolean;
            selectors: Buffer | null;
            selector_key: Buffer | null;
            selector_kek: string | null;
          }>(
            `SELECT workspace_id, erasure_id, profile_ids, state, clickhouse_done, hotstate_done,
                    selectors, selector_key, selector_kek
             FROM erasure_cleanup_jobs`,
          )
        ).rows.map((row) => ({
          workspaceId: row.workspace_id,
          erasureId: row.erasure_id,
          profileIds: row.profile_ids,
          state: row.state,
          clickhouseDone: row.clickhouse_done,
          hotstateDone: row.hotstate_done,
          selectors: row.selectors,
          selectorKey: row.selector_key,
          selectorKek: row.selector_kek,
        }))
      : [];
    return { erasures, tombstones, cleanupJobs };
  });
}

async function eraseFamily(client: pg.Client, workspaceId: string, profileIds: string[]): Promise<number> {
  // Same rows `profiles.erase` removes (packages/profiles/src/commands.ts). Identifiers, profile
  // keys and consent state cascade from profiles; messages have no foreign key, so they go first.
  if (!profileIds.length) return 0;
  const params = [workspaceId, profileIds];
  // Keep the e-mail and phone suppression hashes so the person is never contacted again. Their
  // identifiers are still in the restored snapshot at this point.
  await client.query(
    `INSERT INTO suppressions (workspace_id, channel, value_hash, reason)
     SELECT $1, CASE type WHEN 'email' THEN 'email' ELSE 'sms' END, value, 'erased'
     FROM identifiers
     WHERE workspace_id = $1 AND profile_id = ANY($2) AND type IN ('email', 'phone')
     ON CONFLICT DO NOTHING`,
    params,
  );
  await client.query('DELETE FROM messages WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  // Their browsers and apps stop getting notifications. `push_subscriptions` has no foreign key
  // to profiles (#280), so deleting the profile would leave these rows behind; `profiles.erase`
  // removes them by the anonymous id and user id of the family. The identifiers still exist here,
  // just before the profile delete cascades them away. A snapshot older than the push feature has
  // no table, and then there is nothing to remove.
  if (await hasTable(client, 'push_subscriptions'))
    await client.query(
      `DELETE FROM push_subscriptions
       WHERE workspace_id = $1
         AND (anonymous_id IN (
                SELECT value FROM identifiers
                WHERE workspace_id = $1 AND profile_id = ANY($2) AND type = 'anonymous_id')
           OR user_id IN (
                SELECT value FROM identifiers
                WHERE workspace_id = $1 AND profile_id = ANY($2) AND type = 'user_id'))`,
      params,
    );
  await client.query('DELETE FROM journey_participants WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM segment_memberships WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM consent_records WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM profile_merges WHERE workspace_id = $1 AND (from_id = ANY($2) OR into_id = ANY($2))', params);
  const deleted = await client.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', params);
  return deleted.rowCount ?? 0;
}

export interface ReplayErasuresAfterMigrateOptions extends ReplayErasuresOptions {
  /** The app role's password, needed because the migrations' GRANTs name it. */
  appRolePassword: string;
  appRole?: string;
}

/**
 * Applies pending migrations, then replays the erasure log. A restore replaces the database with
 * the snapshot's schema first: a snapshot taken before 0.15.0 has no `erasure_cleanup_jobs`, so a
 * plain replay would have nowhere to recreate the live database's pending cleanup jobs. Migrating
 * before the replay makes the table exist, so restored ClickHouse and hot-state data is cleaned.
 */
export async function replayErasuresAfterMigrate(
  databaseUrl: string,
  log: ErasureLog,
  opts: ReplayErasuresAfterMigrateOptions,
): Promise<ReplayErasuresResult> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await migrate(pool, {
      appRolePassword: opts.appRolePassword,
      ...(opts.appRole ? { appRole: opts.appRole } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  } finally {
    await pool.end();
  }
  return replayErasures(databaseUrl, log, opts.log ? { log: opts.log } : {});
}

/**
 * Re-applies an erasure log to a restored database, idempotently. Erasures for workspaces the
 * snapshot does not contain are skipped (the people there are not in the snapshot either).
 */
export async function replayErasures(
  databaseUrl: string,
  log: ErasureLog,
  opts: ReplayErasuresOptions = {},
): Promise<ReplayErasuresResult> {
  const result: ReplayErasuresResult = { workspaces: 0, erasures: 0, profiles: 0, tombstones: 0, cleanupJobs: 0, skipped: 0 };
  if (!log.erasures.length && !log.tombstones.length) return result;

  return withClient(databaseUrl, async (client) => {
    const workspaces = new Set((await client.query<{ id: string }>('SELECT id FROM workspaces')).rows.map((row) => row.id));
    const erasuresTable = await hasTable(client, 'erasures');
    const erasuresHaveKeyCount = erasuresTable && (await hasColumn(client, 'erasures', 'warehouse_key_count'));
    const erasureKeysTable = erasuresHaveKeyCount && (await hasTable(client, 'warehouse_erasure_keys'));
    const tombstonesTable = await hasTable(client, 'erasure_tombstones');
    const cleanupJobsTable = await hasTable(client, 'erasure_cleanup_jobs');
    const jobsByErasure = new Map((log.cleanupJobs ?? []).map((job) => [`${job.workspaceId}:${job.erasureId}`, job]));
    if (log.erasures.length && !cleanupJobsTable)
      opts.log?.(
        'warning: the restored database predates erasure_cleanup_jobs; ClickHouse events and hot state are cleaned up by the app only after it migrates, so check the erased people manually',
      );
    if (log.tombstones.length && !tombstonesTable)
      opts.log?.('warning: the restored database predates erasure_tombstones; only profiles and suppression hashes are replayed');

    const byWorkspace = new Map<string, { erasures: ErasureRecord[]; tombstones: ErasureTombstoneRecord[] }>();
    const bucket = (workspaceId: string) => {
      let entry = byWorkspace.get(workspaceId);
      if (!entry) {
        entry = { erasures: [], tombstones: [] };
        byWorkspace.set(workspaceId, entry);
      }
      return entry;
    };
    for (const erasure of log.erasures) bucket(erasure.workspaceId).erasures.push(erasure);
    for (const tombstone of log.tombstones) bucket(tombstone.workspaceId).tombstones.push(tombstone);

    for (const [workspaceId, entries] of byWorkspace) {
      if (!workspaces.has(workspaceId)) {
        result.skipped += entries.erasures.length + entries.tombstones.length;
        continue;
      }
      await client.query('BEGIN');
      try {
        // Row-level security reads this setting; the owner bypasses it, but a restore run as the
        // app role must still see the workspace's rows.
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        for (const erasure of entries.erasures) {
          if (erasuresTable)
            await client.query(
              `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts, at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (workspace_id, id) DO NOTHING`,
              [workspaceId, erasure.id, erasure.profileIds, erasure.requestedBy, erasure.reason, erasure.counts, erasure.at],
            );
          result.profiles += await eraseFamily(client, workspaceId, erasure.profileIds);
          // The erasure row was inserted before eraseFamily (the snapshot still held the person),
          // so its AFTER INSERT trigger counted zero. eraseFamily has now deleted the identifiers
          // and the capture trigger has stored their user/anonymous ids. Reconcile the count with
          // both those keys and the count the live log recorded: deleting restored identifiers must
          // never turn a known positive count into zero, and a later prune must not look like a
          // person who never had event-capable ids (#421).
          // -1 preserves unknown legacy coverage without changing the released integer column.
          if (erasuresHaveKeyCount) {
            const known = erasure.warehouseKeyCount !== undefined && erasure.warehouseKeyCount >= 0 ? erasure.warehouseKeyCount : undefined;
            if (erasureKeysTable) {
              await client.query(
                `WITH captured AS (
                   SELECT count(*)::integer AS n FROM warehouse_erasure_keys k
                    WHERE k.workspace_id = $1 AND k.profile_id = ANY($2::text[])
                 )
                 UPDATE erasures e SET warehouse_key_count = CASE
                   WHEN $3::integer IS NULL AND e.warehouse_key_count <= 0 AND captured.n = 0 THEN -1
                   ELSE GREATEST(e.warehouse_key_count, COALESCE($3::integer, 0), captured.n)
                 END FROM captured WHERE e.workspace_id = $1 AND e.id = $4`,
                [workspaceId, erasure.profileIds, known ?? null, erasure.id],
              );
            } else {
              await client.query(
                `UPDATE erasures SET warehouse_key_count = CASE
                   WHEN $3::integer IS NULL AND warehouse_key_count <= 0 THEN -1
                   ELSE GREATEST(warehouse_key_count, COALESCE($3::integer, 0))
                 END WHERE workspace_id = $1 AND id = $2`,
                [workspaceId, erasure.id, known ?? null],
              );
            }
          }
          // The restored database must clean the external stores again: its ClickHouse snapshot and
          // Valkey state may predate the erasure. The job starts pending, with the selectors the
          // live job carried when it still had them (a completed job purged them); the worker can
          // still delete message and journey events by profile id.
          if (cleanupJobsTable) {
            const job = jobsByErasure.get(`${workspaceId}:${erasure.id}`);
            // Only an erasure that already had a job gets one back. An erasure recorded before
            // durable cleanup is treated as complete, exactly as profiles.erasureStatus reads it;
            // its external work happened synchronously at erase time.
            if (job) {
              const inserted = await client.query(
                `INSERT INTO erasure_cleanup_jobs
                   (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (workspace_id, erasure_id) DO NOTHING`,
                [workspaceId, erasure.id, erasure.profileIds, job.selectors, job.selectorKey, job.selectorKek],
              );
              result.cleanupJobs += inserted.rowCount ?? 0;
            }
          }
          result.erasures += 1;
        }
        for (const tombstone of entries.tombstones) {
          if (!tombstonesTable) break;
          await client.query(
            `INSERT INTO erasure_tombstones (workspace_id, ident_hash, erased_at, erasure_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, ident_hash) DO UPDATE
             SET erased_at = EXCLUDED.erased_at, erasure_id = EXCLUDED.erasure_id`,
            [workspaceId, tombstone.identHash, tombstone.erasedAt, tombstone.erasureId],
          );
          result.tombstones += 1;
        }
        await client.query('COMMIT');
        result.workspaces += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
    return result;
  });
}
