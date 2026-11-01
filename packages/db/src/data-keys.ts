import pg from 'pg';

// Read-only helpers for `am backup`/`am restore`, which deliberately run without the server
// configuration and only need DATABASE_URL (plus a key provider when they can have one).

async function withClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** One stored data key, used to prove that a key provider can still unseal the database. */
export interface StoredDataKeySample {
  id: string;
  workspaceId: string;
  kekId: string;
  wrappedKey: Buffer;
}

/**
 * The first data key in the database, or null when there is none (a fresh install). Connections
 * use the admin DATABASE_URL, which bypasses row-level security, so this sees every workspace.
 */
export function readDataKeySample(databaseUrl: string): Promise<StoredDataKeySample | null> {
  return withClient(databaseUrl, async (client) => {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.data_keys') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return null;
    const { rows } = await client.query<{ id: string; workspace_id: string; kek_id: string; wrapped_key: Buffer }>(
      'SELECT id, workspace_id, kek_id, wrapped_key FROM data_keys ORDER BY created_at, id LIMIT 1',
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, workspaceId: row.workspace_id, kekId: row.kek_id, wrappedKey: row.wrapped_key };
  });
}
