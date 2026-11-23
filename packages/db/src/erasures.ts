import pg from 'pg';
import { migrate } from './migrate';

// Erasures live in the database they protect, so a restore from a snapshot taken before an
// erasure would bring the erased person back (#144). `am restore` reads this log from the live
// database before replacing it and replays it afterwards: profiles and identifiers named by an
// erasure are deleted again, their suppression hashes are restored, the keyed tombstones go back,
// and the durable erasure-key ledger (#1037) is re-inserted, so read-time exclusion still knows the
// erased keys. The replay only queues work that was unfinished; a job the snapshot carries as
// complete is left alone. Publishing the restored ledger to ClickHouse's `erased_subjects` is a
// separate, final step of `am restore`: that table is not part of the Postgres snapshot, so it is
// reconciled from the restored ledger after the last ClickHouse load (#1194). Only pseudonymous ids
// and hashes are involved; no plaintext personal data is copied by the replay.

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

/**
 * One durable erasure-key ledger row (#1037). The keys are pseudonymous by construction: ids the
 * event store already holds, or the matching key's HMAC for e-mail and phone. Replay copies them
 * as they are, so no personal data is decrypted or rewritten.
 */
export interface ErasureKeyRecord {
  workspaceId: string;
  erasureId: string;
  kind: string;
  keyValue: string;
  keyVersion: string;
  /** `full`, or `unavailable` when the identifier plaintext could not be recovered. */
  coverage: string;
  recordedAt: string;
}

/**
 * A wrapped exclusion data key (#1037). The restore capture carries these because the ledger's
 * hashes are useless without the key that produced them: a snapshot from before the key existed
 * would otherwise restore ledger rows and lazily create a different key, so no value would match.
 * The wrapped bytes are already KEK-sealed; the replay never unwraps them.
 */
export interface ExclusionDataKeyRecord {
  workspaceId: string;
  id: string;
  kekId: string;
  wrappedKey: Buffer;
  active: boolean;
  createdAt: string;
}

/**
 * One workspace's publication generation for ClickHouse's erased subjects (#1037 part 2). It is
 * carried through a restore because the ClickHouse table is not part of the Postgres snapshot: a
 * snapshot's counter can be older than what was published, and reusing a generation would make a
 * republished exclusion look older than the row it must replace.
 */
export interface ErasureGenerationRecord {
  workspaceId: string;
  generation: number;
  /** Confirmed publications; the analytics cache epoch (#1037 part 2). */
  publications: number;
}

export interface ErasureLog {
  erasures: ErasureRecord[];
  tombstones: ErasureTombstoneRecord[];
  /** Pending cleanup jobs for the erasures above; absent from a database older than 0.15.0. */
  cleanupJobs?: ErasureCleanupJobRecord[];
  /** The durable erasure-key ledger; absent from a database older than 0.17.0. */
  keys?: ErasureKeyRecord[];
  /** Every exclusion data key (wrapped only) so a restore keeps the ids the ledger references. */
  exclusionKeys?: ExclusionDataKeyRecord[];
  /** Per-workspace publication generations; absent from a database older than 0.17.0. */
  generations?: ErasureGenerationRecord[];
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
  /** Cleanup jobs recreated or reopened for the replayed erasures that were not complete yet. */
  cleanupJobs: number;
  /** Completed jobs recreated as complete because the live log had one the snapshot predates. */
  completedJobs: number;
  /** Erasure-key ledger rows re-inserted into the restored database. */
  keys: number;
  /** Wrapped exclusion data keys re-inserted into the restored database. */
  exclusionKeys: number;
  /** Publication generations replayed (or advanced) in the restored database. */
  generations: number;
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
 * Every live table a restore reads. The tenant ones are under `FORCE ROW LEVEL SECURITY`, so their
 * owner is subject to the policy exactly like the application role: without an `app.workspace_id`
 * the owner reads zero rows, and the restore would replay nothing (#1204 review). A restore must
 * read *every* workspace, so its owner lifts FORCE for one transaction instead of naming one
 * workspace at a time. `warehouse_erasure_key_tracking` is a singleton with no tenant column; it
 * is listed so the catalog check sees the whole set.
 */
const RESTORE_LOG_TABLES = [
  'data_keys',
  'erasure_cleanup_jobs',
  'erasure_generations',
  'erasure_keys',
  'erasure_tombstones',
  'erasures',
  'warehouse_erasure_key_tracking',
  'warehouse_erasure_keys',
] as const;

interface TableRls {
  name: string;
  rls: boolean;
  forced: boolean;
  is_owner: boolean;
  bypass: boolean;
  role: string;
}

/** The row-level-security state of `tables` as it applies to this connection's role. */
async function tableRls(client: pg.Client, tables: readonly string[]): Promise<TableRls[]> {
  const { rows } = await client.query<TableRls>(
    `SELECT c.relname AS name,
            c.relrowsecurity AS rls,
            c.relforcerowsecurity AS forced,
            current_user = pg_get_userbyid(c.relowner) AS is_owner,
            (r.rolsuper OR r.rolbypassrls) AS bypass,
            current_user::text AS role
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  return rows;
}

/**
 * Refuses a role that is neither a table's owner nor able to bypass RLS.
 *
 * The tenant policy filters that role's reads, so it would read the table as empty and the restore
 * would skip the erasures it must replay — quietly resurrecting everyone erased since the snapshot.
 * Nothing has been replaced at this point.
 */
function assertReadsEveryRow(tables: TableRls[], what: string): void {
  const hidden = tables.find((row) => row.rls && !row.bypass && !row.is_owner);
  if (hidden)
    throw new Error(
      `${what} is hidden by row-level security from role ${hidden.role}: it is not the owner of ${hidden.name} and ` +
        'does not have BYPASSRLS, so erasures could be skipped instead of replayed. ' +
        'Run the restore as the table owner or a role with BYPASSRLS.',
    );
}

/** The tables whose FORCE RLS the owner must lift to read every row (none for a role that bypasses it). */
function forcedLiftTargets(tables: TableRls[]): string[] {
  return tables.filter((row) => row.forced && row.is_owner && !row.bypass).map((row) => row.name);
}

/** Runs `read` with FORCE lifted on `tables` for one transaction, so a rollback restores it. */
async function withForcedLift<T>(client: pg.Client, tables: readonly string[], read: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    for (const table of tables) await client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
    const value = await read();
    for (const table of tables) await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * The ids of every workspace in a database. `workspaces` is under FORCE RLS too, and the replay
 * decides from this list whether a captured entry belongs to a workspace the snapshot still has: a
 * forced owner that reads zero rows would skip every erasure as if its workspace were gone (#1204
 * review).
 */
async function listRestoredWorkspaceIds(client: pg.Client): Promise<Set<string>> {
  const read = async () => (await client.query<{ id: string }>('SELECT id FROM workspaces')).rows.map((row) => row.id);
  const plain = await read();
  if (plain.length) return new Set(plain);
  const tables = await tableRls(client, ['workspaces']);
  // A database older than 0.3.0 has no workspaces table, and then there is nothing to replay into.
  if (!tables.length) return new Set();
  assertReadsEveryRow(tables, 'the restored workspace list');
  const lift = forcedLiftTargets(tables);
  return new Set(lift.length ? await withForcedLift(client, lift, read) : await read());
}

/**
 * Reads every erasure and tombstone from a live database. A database older than 0.3.0 has
 * neither table; it then has no erasures to replay. Throws when the log cannot be read, because
 * restoring without it could resurrect people.
 */
export async function readErasureLog(databaseUrl: string): Promise<ErasureLog> {
  return withClient(databaseUrl, async (client) => {
    // The whole log is read in one transaction when FORCE has to be lifted, so a failure anywhere
    // rolls the lift back and no reader ever sees a half-read log.
    const tables = await tableRls(client, RESTORE_LOG_TABLES);
    assertReadsEveryRow(tables, 'the live erasure log');
    const lift = forcedLiftTargets(tables);
    if (!lift.length) return readLog(client);
    return withForcedLift(client, lift, () => readLog(client));
  });
}

async function readLog(client: pg.Client): Promise<ErasureLog> {
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
  // The durable erasure-key ledger (#1037). A database older than 0.17.0 has no table and
  // therefore no ledger rows to carry; an empty list here is that version's honest answer.
  const keys = (await hasTable(client, 'erasure_keys'))
    ? (
        await client.query<{
          workspace_id: string;
          erasure_id: string;
          kind: string;
          key_value: string;
          key_version: string;
          coverage: string;
          recorded_at: Date | string;
        }>('SELECT workspace_id, erasure_id, kind, key_value, key_version, coverage, recorded_at FROM erasure_keys')
      ).rows.map((row) => ({
        workspaceId: row.workspace_id,
        erasureId: row.erasure_id,
        kind: row.kind,
        keyValue: row.key_value,
        keyVersion: row.key_version,
        coverage: row.coverage,
        recordedAt: iso(row.recorded_at),
      }))
    : [];
  // The wrapped exclusion data keys (#1037): the ledger's hashes cannot be matched without them.
  const exclusionKeys =
    (await hasTable(client, 'data_keys')) && (await hasColumn(client, 'data_keys', 'purpose'))
      ? (
          await client.query<{
            workspace_id: string;
            id: string;
            kek_id: string;
            wrapped_key: Buffer;
            active: boolean;
            created_at: Date | string;
          }>(
            `SELECT workspace_id, id, kek_id, wrapped_key, active, created_at
               FROM data_keys WHERE purpose = 'exclusion' ORDER BY workspace_id, created_at`,
          )
        ).rows.map((row) => ({
          workspaceId: row.workspace_id,
          id: row.id,
          kekId: row.kek_id,
          wrappedKey: row.wrapped_key,
          active: row.active,
          createdAt: iso(row.created_at),
        }))
      : [];
  // The publication generations (#1037 part 2): the ClickHouse exclusion state is not in the
  // Postgres snapshot, so the counter must come from the live log or the next publication could
  // reuse a generation that is already visible.
  const generations = (await hasTable(client, 'erasure_generations'))
    ? (
        await client.query<{ workspace_id: string; generation: number | string; visible_publications: number | string }>(
          'SELECT workspace_id, generation, visible_publications FROM erasure_generations',
        )
      ).rows.map((row) => ({
        workspaceId: row.workspace_id,
        generation: Number(row.generation),
        publications: Number(row.visible_publications),
      }))
    : [];
  return { erasures, tombstones, cleanupJobs, keys, exclusionKeys, generations };
}

async function eraseFamily(client: pg.Client, workspaceId: string, profileIds: string[]): Promise<number> {
  // Same rows `profiles.erase` removes (packages/profiles/src/commands.ts). Identifiers, profile
  // keys and consent state cascade from profiles; messages have no foreign key, so they go first.
  if (!profileIds.length) return 0;
  const params = [workspaceId, profileIds];
  // Profile rows before the participant rows deleted below, the shared order
  // (packages/profiles/src/identity.ts, #1011 review): a score finalisation or a journey step takes
  // the same profile lock first, so neither can hold a participant row this deletion wants while
  // waiting for a profile row it holds.
  await client.query('SELECT id FROM profiles WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR NO KEY UPDATE', params);
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
  // The journey hook's per-event markers name the person too (an event id can carry an address), and
  // a restored snapshot brings them back with the person (#1011 review).
  await client.query('DELETE FROM journey_processed_events WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM segment_memberships WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  // Holdout arms are person-keyed rows a report still reads. Their foreign key cascades with the
  // profile; naming the table keeps this replay's list complete (#1048).
  await client.query('DELETE FROM holdout_assignments WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
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
  const result: ReplayErasuresResult = {
    workspaces: 0,
    erasures: 0,
    profiles: 0,
    tombstones: 0,
    cleanupJobs: 0,
    completedJobs: 0,
    keys: 0,
    exclusionKeys: 0,
    generations: 0,
    skipped: 0,
  };
  if (!log.erasures.length && !log.tombstones.length && !log.keys?.length && !log.exclusionKeys?.length && !log.generations?.length)
    return result;

  return withClient(databaseUrl, async (client) => {
    // A restore run as the table owner must still see every workspace here; otherwise every captured
    // entry is "skipped" as if the snapshot no longer had its workspace (#1204 review).
    const workspaces = await listRestoredWorkspaceIds(client);
    const erasuresTable = await hasTable(client, 'erasures');
    const erasuresHaveKeyCount = erasuresTable && (await hasColumn(client, 'erasures', 'warehouse_key_count'));
    const erasureKeysTable = erasuresHaveKeyCount && (await hasTable(client, 'warehouse_erasure_keys'));
    const tombstonesTable = await hasTable(client, 'erasure_tombstones');
    const cleanupJobsTable = await hasTable(client, 'erasure_cleanup_jobs');
    const generationsTable = await hasTable(client, 'erasure_generations');
    const ledgerTable = await hasTable(client, 'erasure_keys');
    const dataKeysTable = (await hasTable(client, 'data_keys')) && (await hasColumn(client, 'data_keys', 'purpose'));
    const jobsByErasure = new Map((log.cleanupJobs ?? []).map((job) => [`${job.workspaceId}:${job.erasureId}`, job]));
    if (log.erasures.length && !cleanupJobsTable)
      opts.log?.(
        'warning: the restored database predates erasure_cleanup_jobs; ClickHouse events and hot state are cleaned up by the app only after it migrates, so check the erased people manually',
      );
    if (log.tombstones.length && !tombstonesTable)
      opts.log?.('warning: the restored database predates erasure_tombstones; only profiles and suppression hashes are replayed');
    if (log.keys?.length && !ledgerTable)
      opts.log?.(
        'warning: the restored database predates erasure_keys; the durable erasure-key ledger is replayed only after the app migrates, so run the migration before serving reads',
      );
    if (log.exclusionKeys?.length && !dataKeysTable)
      opts.log?.(
        'warning: the restored database predates data key purposes; exclusion keys cannot be replayed, so run the migration before serving reads',
      );

    const byWorkspace = new Map<string, { erasures: ErasureRecord[]; tombstones: ErasureTombstoneRecord[]; keys: ErasureKeyRecord[] }>();
    const bucket = (workspaceId: string) => {
      let entry = byWorkspace.get(workspaceId);
      if (!entry) {
        entry = { erasures: [], tombstones: [], keys: [] };
        byWorkspace.set(workspaceId, entry);
      }
      return entry;
    };
    for (const erasure of log.erasures) bucket(erasure.workspaceId).erasures.push(erasure);
    for (const tombstone of log.tombstones) bucket(tombstone.workspaceId).tombstones.push(tombstone);
    for (const key of log.keys ?? []) bucket(key.workspaceId).keys.push(key);
    // A workspace can have exclusion keys and hashed event rows without any erasure yet (a probe
    // caught exactly that). Its key must still be replayed, or every stored hash loses its key.
    for (const key of log.exclusionKeys ?? []) bucket(key.workspaceId);
    for (const generation of log.generations ?? []) bucket(generation.workspaceId);

    for (const [workspaceId, entries] of byWorkspace) {
      if (!workspaces.has(workspaceId)) {
        result.skipped +=
          entries.erasures.length +
          entries.tombstones.length +
          entries.keys.length +
          (log.exclusionKeys ?? []).filter((key) => key.workspaceId === workspaceId).length +
          (log.generations ?? []).filter((generation) => generation.workspaceId === workspaceId).length;
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
          //
          // An erasure with committed ledger rows always gets its job back, even when the live
          // database had none: the ledger rows were written by a release whose cleanup ran before
          // publication existed (or before durable jobs), and `erased_subjects` must be published
          // for them after a restore (#1037 part 2).
          if (cleanupJobsTable) {
            const job = jobsByErasure.get(`${workspaceId}:${erasure.id}`);
            // Only this erasure's own ledger rows justify a job: another erasure's keys in the same
            // workspace must not re-open work for this one.
            if (job || entries.keys.some((key) => key.erasureId === erasure.id)) {
              // Only a job the snapshot did not finish is reopened (~#1194). A job the live log says
              // was complete is inserted as complete, even on a snapshot old enough that the dump
              // predates the job row: the restore's final reconciliation publishes and verifies its
              // ledger keys in bulk instead of making the scheduler sweep every historical erasure
              // again. A job that was still pending, running or failed is queued for its remaining
              // sweep. The upsert is idempotent: a second replay rewrites the same queued state.
              const wasComplete = job?.state === 'complete';
              const inserted = await client.query(
                `INSERT INTO erasure_cleanup_jobs
                   (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek,
                    state, clickhouse_done, hotstate_done, completed_at)
                 VALUES ($1, $2, $3, $4, $5, $6,
                         CASE WHEN $7 THEN 'complete' ELSE 'pending_external' END,
                         $7, $7, CASE WHEN $7 THEN now() ELSE NULL END)
                 ON CONFLICT (workspace_id, erasure_id) DO UPDATE
                   SET profile_ids = EXCLUDED.profile_ids,
                       state = 'pending_external',
                       attempts = 0,
                       next_attempt_at = now(),
                       lease_until = NULL,
                       claim_token = NULL,
                       clickhouse_done = false,
                       hotstate_done = false,
                       final_sweep_at = NULL,
                       first_sweep_done_at = NULL,
                       published_generation = NULL,
                       published_at = NULL,
                       coverage_cleared_at = NULL,
                       completion_reason = NULL,
                       completed_at = NULL,
                       last_error = NULL,
                       selectors = CASE WHEN erasure_cleanup_jobs.selectors IS NOT NULL THEN erasure_cleanup_jobs.selectors
                                        ELSE EXCLUDED.selectors END,
                       selector_key = CASE WHEN erasure_cleanup_jobs.selectors IS NOT NULL THEN erasure_cleanup_jobs.selector_key
                                           ELSE EXCLUDED.selector_key END,
                       selector_kek = CASE WHEN erasure_cleanup_jobs.selectors IS NOT NULL THEN erasure_cleanup_jobs.selector_kek
                                           ELSE EXCLUDED.selector_kek END,
                       updated_at = now()
                 WHERE erasure_cleanup_jobs.state <> 'complete'`,
                [
                  workspaceId,
                  erasure.id,
                  erasure.profileIds,
                  job?.selectors ?? null,
                  job?.selectorKey ?? null,
                  job?.selectorKek ?? null,
                  wasComplete,
                ],
              );
              if (wasComplete) result.completedJobs += inserted.rowCount ?? 0;
              else result.cleanupJobs += inserted.rowCount ?? 0;
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
        // The durable ledger is replayed as-is: the values are already pseudonymous ids or keyed
        // hashes. A key the restored snapshot already had is left alone, so a replay never moves
        // its erasure or recorded time backwards.
        for (const key of entries.keys) {
          if (!ledgerTable) break;
          const inserted = await client.query(
            `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (workspace_id, kind, key_value, key_version) DO NOTHING`,
            [workspaceId, key.kind, key.keyValue, key.keyVersion, key.erasureId, key.coverage, key.recordedAt],
          );
          result.keys += inserted.rowCount ?? 0;
        }
        // The wrapped exclusion keys the ledger references. A snapshot taken before the key existed
        // would otherwise lazily create a different one and no ledger value would ever match.
        const capturedKeys = (log.exclusionKeys ?? []).filter((key) => key.workspaceId === workspaceId);
        if (dataKeysTable && capturedKeys.length) {
          for (const key of capturedKeys) {
            const inserted = await client.query(
              `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose, created_at)
               VALUES ($1, $2, $3, $4, false, 'exclusion', $5)
               ON CONFLICT (workspace_id, id) DO NOTHING`,
              [workspaceId, key.id, key.kekId, key.wrappedKey, key.createdAt],
            );
            result.exclusionKeys += inserted.rowCount ?? 0;
          }
        }
        if (dataKeysTable) {
          // The key the ledger rows reference wins. Never leave a second active exclusion key for a
          // workspace that has ledger rows: its next write would hash with the wrong key.
          const referenced = [...new Set(entries.keys.map((key) => key.keyVersion).filter(Boolean))];
          let target: string | undefined;
          if (referenced.length) {
            target = capturedKeys.find((key) => key.active && referenced.includes(key.id))?.id;
            if (!target) {
              const existing = await client.query<{ id: string }>(
                `SELECT id FROM data_keys WHERE workspace_id = $1 AND purpose = 'exclusion' AND id = ANY($2)
                 ORDER BY created_at DESC`,
                [workspaceId, referenced],
              );
              target = existing.rows[0]?.id;
            }
            if (target) {
              await client.query(
                `UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'exclusion' AND active AND id <> $2`,
                [workspaceId, target],
              );
              await client.query(`UPDATE data_keys SET active = true WHERE workspace_id = $1 AND id = $2`, [workspaceId, target]);
            } else {
              await client.query(`UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'exclusion' AND active`, [
                workspaceId,
              ]);
              opts.log?.(
                'warning: the ledger references an exclusion key the restore did not capture; writes will refuse until that key is restored',
              );
            }
          } else {
            const active = capturedKeys.find((key) => key.active)?.id;
            if (active) {
              await client.query(
                `UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'exclusion' AND active AND id <> $2`,
                [workspaceId, active],
              );
              await client.query(`UPDATE data_keys SET active = true WHERE workspace_id = $1 AND id = $2`, [workspaceId, active]);
            }
          }
        }
        // The workspace's publication generation (#1037 part 2). ClickHouse keeps the exclusions
        // across a Postgres restore, so the counter may only move forward: a snapshot's lower
        // value must never make a later publication reuse a visible generation.
        const capturedGenerations = (log.generations ?? []).filter((entry) => entry.workspaceId === workspaceId);
        if (generationsTable && capturedGenerations.length) {
          const highest = Math.max(...capturedGenerations.map((entry) => entry.generation));
          const publications = Math.max(...capturedGenerations.map((entry) => entry.publications));
          const applied = await client.query(
            `INSERT INTO erasure_generations (workspace_id, generation, visible_publications) VALUES ($1, $2, $3)
             ON CONFLICT (workspace_id) DO UPDATE
               SET generation = GREATEST(erasure_generations.generation, EXCLUDED.generation),
                   visible_publications = GREATEST(erasure_generations.visible_publications, EXCLUDED.visible_publications),
                   updated_at = now()
             RETURNING generation`,
            [workspaceId, highest, publications],
          );
          if (applied.rowCount) result.generations += 1;
        }
        // A restore may put back a ClickHouse snapshot from before a physical purge, so purge
        // progress is not evidence after a replay: reset it and let the recurring sweep run again
        // (#1037 part 3). The publication generation itself stays monotonic above.
        if (generationsTable)
          await client.query(
            `UPDATE erasure_generations
                SET purged_generation = 0, purge_last_sweep_at = NULL,
                    purge_claim_token = NULL, purge_lease_until = NULL, updated_at = now()
              WHERE workspace_id = $1`,
            [workspaceId],
          );
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

// The restore interlock that replaced the settings marker lives in `restoreFence.ts` (#1194). It is
// written before Postgres is replaced, not after, so a `pg_restore` that commits and then fails also
// leaves a fence behind.
