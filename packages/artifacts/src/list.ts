/**
 * Keyset cursor for `artifacts.list`, which pages newest-first by `updatedAt` with the artifact id
 * as the tie-breaker. Kept in its own module so the encoding is unit-testable without a database.
 *
 * `updatedAt` is the database's own timestamp text rather than a JavaScript `Date`: Postgres stores
 * microseconds and `Date` only keeps milliseconds, so rounding would skip rows that share a
 * millisecond at a page boundary.
 */
export const ARTIFACT_LIST_MAX_LIMIT = 200;

export interface ArtifactListCursor {
  /** `updated_at::text` from Postgres, including its full precision and offset. */
  updatedAt: string;
  id: string;
}

/** The opaque cursor for the last row of a page: `${updatedAt}~${id}`. */
export function encodeArtifactListCursor(row: { updatedAt: string; id: string }): string {
  return `${row.updatedAt}~${row.id}`;
}

/** Parses a cursor, or returns null so the command can report a clear invalid_input error. */
export function decodeArtifactListCursor(cursor: string): ArtifactListCursor | null {
  const at = cursor.lastIndexOf('~');
  if (at <= 0) return null;
  const updatedAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt))) return null;
  return { updatedAt, id };
}
