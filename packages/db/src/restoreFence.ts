import type pg from 'pg';

/**
 * The restore interlock (#1194).
 *
 * A restore replaces Postgres and then ClickHouse, and ClickHouse's `erased_subjects` is not part
 * of the Postgres dump. A restore that stops between the two can therefore pair a database whose
 * cleanup job says "published" with a ClickHouse point that never saw the exclusions. Two things
 * keep that from serving an erased person:
 *
 * - a fence row, written **before** the Postgres replacement and removed only after the restored
 *   ledger is confirmed visible in ClickHouse. It lives in `public.restore_fence`, which every
 *   backup excludes (`pg_dump --exclude-table`), so `pg_restore --clean` cannot drop it, and a
 *   failed or interrupted restore leaves it behind for the next server start to refuse;
 * - one session-level advisory lock held by `am restore` from before the drain check until the
 *   fence is cleared. It is server state rather than data, so it survives `pg_restore`, and it
 *   refuses a second restore even when the two use different backup directories.
 */

/**
 * The advisory-lock key shared by `am restore` (exclusive) and server startup (shared). It is a
 * fixed, application-specific value; changing it would let an old and a new binary ignore each
 * other. `0x414d5253` spells "AMRS".
 */
export const RESTORE_ADVISORY_LOCK_KEY = 0x414d5253;

/** The fence table, in `public` so a small install's migration role can create it. */
export const RESTORE_FENCE_TABLE = 'public.restore_fence';

export interface RestoreFenceState {
  /** The backup directory being restored, for the operator; never secret. */
  backup: string;
  startedAt: string;
}

type FenceClient = Pick<pg.Pool, 'query'> | Pick<pg.Client, 'query'>;

export type { FenceClient };

/** PostgreSQL's undefined_table; a database restored from before this release has no fence yet. */
function isMissingFenceTable(err: unknown): boolean {
  return (err as { code?: string }).code === '42P01';
}

/**
 * Creates the fence table when it is missing. The restore calls this on a fresh target, whose
 * database has no schema yet; the migration is the normal path, and both use the same shape.
 */
export async function ensureRestoreFenceTable(client: FenceClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${RESTORE_FENCE_TABLE} (
       id integer PRIMARY KEY CHECK (id = 1),
       started_at timestamptz NOT NULL,
       backup text NOT NULL
     )`,
  );
}

/**
 * Raises the fence before anything replaces Postgres. It is idempotent: retrying a failed restore
 * overwrites the row with the newest attempt, which is what the operator should see at startup.
 */
export async function raiseRestoreFence(client: FenceClient, state: RestoreFenceState): Promise<void> {
  await ensureRestoreFenceTable(client);
  await client.query(
    `INSERT INTO ${RESTORE_FENCE_TABLE} (id, started_at, backup) VALUES (1, $1::timestamptz, $2)
     ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, backup = EXCLUDED.backup`,
    [state.startedAt, state.backup],
  );
}

/**
 * Clears the fence only after reconciliation succeeded. A missing table means there was no fence
 * to clear (a snapshot from before this release, or a target that never had one).
 *
 * With `match`, only that attempt's row is removed: a restore whose lock connection was lost can
 * race a second restore that has already raised its own fence, and an unconditional delete would
 * remove the newer attempt's marker (#1204 review). Returns the number of rows removed.
 */
export async function clearRestoreFence(client: FenceClient, match?: RestoreFenceState): Promise<number> {
  try {
    const { rowCount } = match
      ? await client.query(`DELETE FROM ${RESTORE_FENCE_TABLE} WHERE id = 1 AND started_at = $1::timestamptz AND backup = $2`, [
          match.startedAt,
          match.backup,
        ])
      : await client.query(`DELETE FROM ${RESTORE_FENCE_TABLE}`);
    return rowCount ?? 0;
  } catch (err) {
    if (!isMissingFenceTable(err)) throw err;
    return 0;
  }
}

/** The raised fence, or null when the table (and therefore the fence) does not exist. */
export async function restoreFenceState(client: FenceClient): Promise<RestoreFenceState | null> {
  try {
    const { rows } = await client.query<{ backup: string; started_at: Date | string }>(
      `SELECT backup, started_at FROM ${RESTORE_FENCE_TABLE} WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return { backup: row.backup, startedAt: new Date(row.started_at).toISOString() };
  } catch (err) {
    if (isMissingFenceTable(err)) return null;
    throw err;
  }
}
