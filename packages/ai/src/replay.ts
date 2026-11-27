import { mergeComponentCtes } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import type { Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';

// An idempotent read caches its whole answer for 30 days. An answer that lists AI calls holds their
// inputs, outputs, rationales and review notes, which are person data, and erasure deletes the call
// rows with the person. `ai.calls` and `ai.reviews` share this replay gate: the answered rows must
// still exist, and the people they name must still be there, or the cached answer is not handed
// back (#1300 review).

/**
 * Refuses a replay whose stored answer lists AI calls that no longer exist. One batched statement
 * asks for every answered call (`= ANY(text[])`), and one more resolves the people those rows name
 * (following a merge, bounded like every other walk), so a list of any size costs two statements.
 * The message is the caller's own: each command names what it answered.
 */
export async function assertCallsReplayable(tx: Tx, workspaceId: string, callIds: readonly string[], stale: string): Promise<void> {
  const ids = [...new Set(callIds)];
  if (!ids.length) return;
  const { rows } = await tx.execute<{ id: string; person_id: string | null }>(sql`
    SELECT id, profile_id AS person_id FROM ai_calls
    WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(ids)}::text[])`);
  // A call erased with its person, or a partially erased list, leaves fewer rows than the answer
  // listed: the cached copy describes people the workspace can no longer answer for.
  if (rows.length !== ids.length) throw new AppError('not_found', stale);
  const people = [...new Set(rows.map((r) => r.person_id).filter((id): id is string => id !== null))];
  if (!people.length) return;
  const resolved = await tx.execute<{ origin: string; id: string | null }>(sql`
    WITH RECURSIVE ${mergeComponentCtes(workspaceId, { seeds: sql`SELECT unnest(${sql.param(people)}::text[]) AS id` })}
    SELECT mr.origin, p.id
    FROM merge_representative mr
    LEFT JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = mr.representative COLLATE "default" AND p.merged_into IS NULL`);
  const alive = new Set(resolved.rows.filter((r) => r.id !== null).map((r) => r.origin));
  if (people.some((id) => !alive.has(id))) throw new AppError('not_found', stale);
}
