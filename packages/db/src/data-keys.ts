import pg from 'pg';
import { withApplicationName } from './pool';
import { assertReadsEveryRow, forcedLiftTargets, tableRls, withForcedLift } from './roles';

// Read-only helpers for `am backup`/`am restore`, which deliberately run without the server
// configuration and only need DATABASE_URL (plus a key provider when they can have one).

async function withClient<T>(
  scope: {
    databaseUrl: string;
    applicationName?: string;
    connectionTimeoutMillis?: number;
    statementTimeoutMillis?: number;
    lockTimeoutMillis?: number;
  },
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    // The URL wins over the option in node-postgres, so the name has to be set there too (#1204 review).
    connectionString:
      scope.applicationName === undefined ? scope.databaseUrl : withApplicationName(scope.databaseUrl, scope.applicationName),
    ...(scope.connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis: scope.connectionTimeoutMillis }),
  });
  await client.connect();
  try {
    // A caller such as `am doctor` must not leave a query or a lock wait running past its own
    // budget: bound both on the server, so the statement aborts and this finally closes the client
    // even if the caller has already given up (#1221 review).
    if (scope.statementTimeoutMillis !== undefined)
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(scope.statementTimeoutMillis)]);
    if (scope.lockTimeoutMillis !== undefined)
      await client.query("SELECT set_config('lock_timeout', $1, false)", [String(scope.lockTimeoutMillis)]);
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** One stored data key, used to prove that a key provider can still unseal the database. */
export interface StoredDataKeySample {
  id: string;
  workspaceId: string;
  kekId: string;
  wrappedKey: Buffer;
}

interface DataKeyRow {
  id: string;
  workspace_id: string;
  kek_id: string;
  wrapped_key: Buffer;
}

const sampleOf = (row: DataKeyRow): StoredDataKeySample => ({
  id: row.id,
  workspaceId: row.workspace_id,
  kekId: row.kek_id,
  wrappedKey: row.wrapped_key,
});

/**
 * The first data key in the database, or null when there is none (a fresh install).
 *
 * `data_keys` is under FORCE RLS. A table owner without BYPASSRLS reads zero rows with a plain
 * SELECT, which used to look exactly like a fresh install: the post-restore key check, the backup's
 * trial unseal and `am doctor` all reported "no data keys" over a populated database (#1221). Lift
 * FORCE for the read, and refuse a role that can see neither.
 *
 * The ownership and RLS state is checked before the read, never after: with `app.workspace_id` set
 * on an owner connection, a plain SELECT returns one workspace's key and looks like the first key
 * in the database. Reading inside the lift — when there is one — sees every workspace.
 */
export function readDataKeySample(
  databaseUrl: string,
  opts: {
    applicationName?: string;
    connectionTimeoutMillis?: number;
    statementTimeoutMillis?: number;
    lockTimeoutMillis?: number;
  } = {},
): Promise<StoredDataKeySample | null> {
  return withClient(
    {
      databaseUrl,
      applicationName: opts.applicationName,
      connectionTimeoutMillis: opts.connectionTimeoutMillis,
      statementTimeoutMillis: opts.statementTimeoutMillis,
      lockTimeoutMillis: opts.lockTimeoutMillis,
    },
    async (client) => {
      const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.data_keys') IS NOT NULL AS present");
      if (!present.rows[0]?.present) return null;
      const read = async () =>
        (await client.query<DataKeyRow>('SELECT id, workspace_id, kek_id, wrapped_key FROM data_keys ORDER BY created_at, id LIMIT 1'))
          .rows[0];
      const tables = await tableRls(client, ['data_keys']);
      assertReadsEveryRow(tables, 'the data keys', 'the key check would be skipped');
      const lift = forcedLiftTargets(tables);
      const row = lift.length ? await withForcedLift(client, lift, read) : await read();
      return row ? sampleOf(row) : null;
    },
  );
}
