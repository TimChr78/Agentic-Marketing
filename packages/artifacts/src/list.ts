import { decodeTimestampCursor, encodeTimestampCursor } from '@agentic-marketing/core';

/**
 * Keyset cursor for `artifacts.list`, which pages newest-first by `updatedAt` with the artifact id
 * as the tie-breaker. The encoding itself lives in `@agentic-marketing/core` so other timestamp
 * lists (`broadcasts.list`, `agents.runFailures`, `approvals.list`) share the exact same format.
 */
export const ARTIFACT_LIST_MAX_LIMIT = 200;

export interface ArtifactListCursor {
  /** Full-precision UTC timestamp from Postgres (legacy offset timestamps are also accepted). */
  updatedAt: string;
  id: string;
}

/** The opaque cursor for the last row of a page: `${updatedAt}~${id}`. */
export function encodeArtifactListCursor(row: { updatedAt: string; id: string }): string {
  return encodeTimestampCursor({ at: row.updatedAt, id: row.id });
}

/** Parses a cursor, or returns null so the command can report a clear invalid_input error. */
export function decodeArtifactListCursor(cursor: string): ArtifactListCursor | null {
  const parsed = decodeTimestampCursor(cursor);
  return parsed ? { updatedAt: parsed.at, id: parsed.id } : null;
}
