import type pg from 'pg';

/**
 * The writer protocol this build implements (#1066).
 *
 * The lock protocol (docs/architecture/data-platform.md, "Workspace lock protocol") and the
 * 0.17.0 erasure contract assume that writers of two versions never run together. The migration
 * that changes the protocol records its version in `writer_protocol`; bump this constant in the
 * same release. An older server then refuses to start against a newer database instead of rolling
 * back across a drained upgrade and writing beside processes that implement a newer protocol.
 */
export const WRITER_PROTOCOL_VERSION = 1;

/**
 * A message when the database records a newer writer protocol than this build implements, else
 * null. A database that has not run the marker migration is unknown rather than newer, so an
 * install upgrading from before 0.17.2 still starts and applies the migration.
 */
export async function writerProtocolMismatch(admin: Pick<pg.Pool, 'query'>, implemented = WRITER_PROTOCOL_VERSION): Promise<string | null> {
  try {
    const { rows } = await admin.query<{ protocol_version: number }>(
      'SELECT protocol_version FROM writer_protocol ORDER BY protocol_version DESC LIMIT 1',
    );
    const active = rows[0]?.protocol_version;
    if (active === undefined || active <= implemented) return null;
    return `The database records writer protocol version ${active}, but this server implements version ${implemented}. Refusing to start: old and new writers must not run together. Follow the drain in UPGRADING.md and run a server version that implements protocol ${active}.`;
  } catch (err) {
    // A database from before the marker migration has no table yet; the migration adds it.
    if ((err as { code?: string }).code === '42P01') return null;
    throw err;
  }
}
