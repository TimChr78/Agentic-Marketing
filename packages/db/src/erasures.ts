import pg from 'pg';

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
}

export interface ErasureTombstoneRecord {
  workspaceId: string;
  identHash: string;
  erasedAt: string;
  erasureId: string;
}

export interface ErasureLog {
  erasures: ErasureRecord[];
  tombstones: ErasureTombstoneRecord[];
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

const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * Reads every erasure and tombstone from a live database. A database older than 0.3.0 has
 * neither table; it then has no erasures to replay. Throws when the log cannot be read, because
 * restoring without it could resurrect people.
 */
export async function readErasureLog(databaseUrl: string): Promise<ErasureLog> {
  return withClient(databaseUrl, async (client) => {
    const erasures = (await hasTable(client, 'erasures'))
      ? (
          await client.query<{
            workspace_id: string;
            id: string;
            profile_ids: string[];
            requested_by: string;
            reason: string;
            counts: Record<string, number>;
            at: Date | string;
          }>('SELECT workspace_id, id, profile_ids, requested_by, reason, counts, at FROM erasures')
        ).rows.map((row) => ({
          workspaceId: row.workspace_id,
          id: row.id,
          profileIds: row.profile_ids,
          requestedBy: row.requested_by,
          reason: row.reason,
          counts: row.counts,
          at: iso(row.at),
        }))
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
    return { erasures, tombstones };
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
  await client.query('DELETE FROM journey_participants WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM segment_memberships WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM consent_records WHERE workspace_id = $1 AND profile_id = ANY($2)', params);
  await client.query('DELETE FROM profile_merges WHERE workspace_id = $1 AND (from_id = ANY($2) OR into_id = ANY($2))', params);
  const deleted = await client.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', params);
  return deleted.rowCount ?? 0;
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
  const result: ReplayErasuresResult = { workspaces: 0, erasures: 0, profiles: 0, tombstones: 0, skipped: 0 };
  if (!log.erasures.length && !log.tombstones.length) return result;

  return withClient(databaseUrl, async (client) => {
    const workspaces = new Set((await client.query<{ id: string }>('SELECT id FROM workspaces')).rows.map((row) => row.id));
    const erasuresTable = await hasTable(client, 'erasures');
    const tombstonesTable = await hasTable(client, 'erasure_tombstones');
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
