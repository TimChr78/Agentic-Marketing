import { type SQL, sql } from 'drizzle-orm';

// One notion of a person's merge component (#985).
//
// `profiles.merged_into` is a functional graph: every profile points at most once, at the profile
// it was merged into. A person is one connected component of that graph. The send path used to
// walk backwards without a bound while the report walked forwards with a 20-hop bound, so a chain
// longer than the bound (or a cycle) gave the two paths different people: the report counted two,
// the send held the person out through an assignment the report grouped elsewhere.
//
// A hop bound cannot be shared into agreement: bounded forwards from two ends of one chain reach
// different nodes, and bounded backwards from the same node reaches a different set depending on
// where the walk started. So this module defines the component once, with no truncation:
//
//   * the representative of an id is the end of its chain; on a corrupted cycle it is the lowest
//     id on the cycle (COLLATE "C"), so every member of a cycle resolves to the same person;
//   * the component of a representative is every profile whose chain reaches it, cycle-safe.
//
// The walk is cycle-safe through a visited path, so no bound is needed to terminate. Both the send
// path and the report use these CTEs, and so does the campaign identity map (#986).

/**
 * The CTEs that resolve seeds to their person and a person to their component. Compose it inside a
 * `WITH RECURSIVE` list:
 *
 * ```sql
 * WITH RECURSIVE ${mergeComponentCtes(workspaceId, { seeds })}
 * SELECT ... FROM merge_representative
 * ```
 *
 * `seeds` must produce a single text column `id` and adds `merge_walk` + `merge_representative`.
 * `componentOf` must produce a single text column `rep` and adds
 * `merge_component(representative, profile_id)`. A caller that only needs one half passes only it:
 * the identity map resolves representatives from its scope and expands components separately.
 * `merge_component` lists each connected profile once (a functional graph is a tree plus at most
 * one cycle, which the visited path cuts), so a caller can `LIMIT` it to stop at a bound early.
 */
export function mergeComponentCtes(workspaceId: string, opts: { seeds?: SQL; componentOf?: SQL }): SQL {
  if (!opts.seeds && !opts.componentOf) throw new Error('mergeComponentCtes needs seeds, componentOf or both');
  const parts: SQL[] = [];
  if (opts.seeds)
    parts.push(
      // One row per step of each chain. `done` marks the final row when the walk meets a visited
      // node: the row carries the repeated id so the caller can find the cycle it closes.
      sql`merge_walk(origin, node, path, done) AS (
        SELECT seed.id, seed.id, ARRAY[seed.id], false
        FROM (${opts.seeds}) AS seed(id)
        UNION ALL
        SELECT w.origin, p.merged_into, w.path || p.merged_into, p.merged_into = ANY(w.path)
        FROM merge_walk w
        JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = w.node
        WHERE p.merged_into IS NOT NULL AND NOT w.done
      )`,
      // The last row of each chain is the representative: a profile that is nobody's alias, a
      // dangling reference, or the edge that closes a cycle. A cycle's representative is the lowest
      // id on it, an order-independent answer that every member of the cycle agrees with.
      sql`merge_representative(origin, representative) AS (
        SELECT w.origin,
          CASE WHEN w.done
            THEN (SELECT min(cycle.node COLLATE "C") FROM unnest(w.path[array_position(w.path, w.node):]) AS cycle(node))
            ELSE w.node
          END
        FROM merge_walk w
        WHERE w.done OR NOT EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.workspace_id = ${workspaceId} AND p.id = w.node AND p.merged_into IS NOT NULL
        )
      )`,
    );
  if (opts.componentOf)
    parts.push(sql`merge_component(representative, profile_id, path) AS (
      SELECT seed.rep, seed.rep, ARRAY[seed.rep]
      FROM (${opts.componentOf}) AS seed(rep)
      UNION ALL
      SELECT c.representative, child.id, c.path || child.id
      FROM merge_component c
      JOIN profiles child ON child.workspace_id = ${workspaceId} AND child.merged_into = c.profile_id
      WHERE NOT (child.id = ANY(c.path))
    )`);
  return sql.join(parts, sql`, `);
}
