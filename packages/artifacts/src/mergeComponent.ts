import { type SQL, sql } from 'drizzle-orm';

// One notion of a person's merge component (#985, #1015 review).
//
// `profiles.merged_into` is a functional graph: every profile points at most once, at the profile
// it was merged into. A person is one connected component of that graph. The send path used to
// walk backwards without a bound while the report walked forwards with a 20-hop bound, so a chain
// longer than the bound (or a cycle) gave the two paths different people.
//
// A hop bound cannot be shared into agreement if only one side truncates: bounded forwards from two
// ends of one chain reach different nodes. So every path resolves a profile the same way, through
// these CTEs, and the holdout send only considers assignments whose resolved representative is its
// own person's (see `oldestArmQuery`), which makes send and report agree at any depth.
//
// * The representative of an id is the end of its chain; on a corrupted cycle it is the lowest id
//   on the cycle (COLLATE "C"), so every member of a cycle resolves to the same person. A chain
//   deeper than `MERGE_MAX_HOPS` resolves to the profile itself and is marked `truncated`: that
//   keeps resolution idempotent (`rep(rep(x)) = rep(x)`), so the send can never copy an arm onto a
//   profile the report groups under a different person.
// * The component of a representative is every profile whose chain reaches it, cycle-safe.
//
// Both walks are bounded (`MERGE_MAX_HOPS`) so a corrupt chain cannot drive an unbounded recursive
// scan, and both use Postgres' CYCLE clause for cycle detection instead of carrying a hand-built
// path array. The forward walk only keeps a row per step up to the bound.

/** The most merge hops one walk follows before it stops and reports `truncated`. */
export const MERGE_MAX_HOPS = 256;

/**
 * The CTEs that resolve seeds to their person and a person to their component. Compose it inside a
 * `WITH RECURSIVE` list:
 *
 * ```sql
 * WITH RECURSIVE ${mergeComponentCtes(workspaceId, { seeds })}
 * SELECT ... FROM merge_representative
 * ```
 *
 * `seeds` must produce a single text column `id` and adds `<name>_walk` + `<name>_representative`.
 * `componentOf` must produce a single text column `rep` and adds
 * `<name>_component(representative, profile_id, depth)`. A caller that needs two resolutions in one
 * statement passes different `name`s. `name` defaults to `merge`.
 *
 * A representative is always a fixed point of resolution: a terminal is itself, a cycle's lowest
 * id is itself, and a chain past the bound resolves to the profile itself. The send path relies on
 * that when it re-records an arm under `person`, and the report groups by the same value.
 *
 * The representative's cycle minimum keeps the explicit `"C"` collation so the choice is stable in
 * any database locale, but every CTE that hands a representative out for a join casts it back to
 * the column collation (`COLLATE "default"`): comparing a `"C"` expression with
 * `profiles.merged_into` cannot use `profiles_merged_into` and turns each send lookup into a scan.
 */
export function mergeComponentCtes(workspaceId: string, opts: { seeds?: SQL; componentOf?: SQL; name?: string }): SQL {
  if (!opts.seeds && !opts.componentOf) throw new Error('mergeComponentCtes needs seeds, componentOf or both');
  const name = opts.name ?? 'merge';
  const walk = sql.raw(`${name}_walk`);
  const representative = sql.raw(`${name}_representative`);
  const component = sql.raw(`${name}_component`);
  const parts: SQL[] = [];
  if (opts.seeds)
    parts.push(
      // One row per hop, up to the bound. The CYCLE clause marks the row that closes a corrupted
      // cycle and stops expanding it, so no hand-built path array grows with the chain.
      sql`${walk}(origin, node, depth) AS (
        SELECT seed.id, seed.id, 0
        FROM (${opts.seeds}) AS seed(id)
        UNION ALL
        SELECT w.origin, p.merged_into, w.depth + 1
        FROM ${walk} w
        JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = w.node
        WHERE p.merged_into IS NOT NULL AND w.depth < ${MERGE_MAX_HOPS}
      ) CYCLE node SET is_cycle USING cycle_path`,
      // One row per chain: its terminal, the cycle's lowest id, or the profile itself when the
      // bound stopped it (marked truncated). Resolution is then idempotent, which is what lets the
      // send re-record an arm under `person` without moving it into another person's report group.
      // `"C"` is for the cycle choice only; callers cast the value back before using it as a key.
      sql`${representative}(origin, representative, truncated) AS (
        SELECT w.origin,
          CASE
            WHEN w.is_cycle
              THEN (SELECT min(cycle.node COLLATE "C") FROM unnest(w.cycle_path[array_position(w.cycle_path, ROW(w.node)):]) AS cycle(node text))
            WHEN w.depth >= ${MERGE_MAX_HOPS} AND p.merged_into IS NOT NULL THEN w.origin
            ELSE w.node
          END,
          (NOT w.is_cycle AND w.depth >= ${MERGE_MAX_HOPS} AND p.merged_into IS NOT NULL)
        FROM ${walk} w
        LEFT JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = w.node
        WHERE w.is_cycle OR w.depth >= ${MERGE_MAX_HOPS} OR p.merged_into IS NULL
      )`,
    );
  if (opts.componentOf)
    parts.push(sql`${component}(representative, profile_id, depth) AS (
      SELECT seed.rep COLLATE "default", seed.rep COLLATE "default", 0
      FROM (${opts.componentOf}) AS seed(rep)
      UNION ALL
      SELECT c.representative, child.id, c.depth + 1
      FROM ${component} c
      JOIN profiles child ON child.workspace_id = ${workspaceId} AND child.merged_into = c.profile_id
      WHERE c.depth < ${MERGE_MAX_HOPS}
    ) CYCLE profile_id SET is_cycle USING cycle_path`);
  return sql.join(parts, sql`, `);
}
