-- One-off repair for static-list membership rows stranded on a merged-away profile (#1102),
-- following the model of 0069's repair pass.
--
-- #1097 closes the race in new writes, but rows written before it can still sit on a profile that
-- was later folded into another: every read follows the survivor and never sees them, and
-- `audiences.remove` aimed at the survivor cannot delete a row keyed on the folded id. This pass
-- resolves each stranded profile to the end of its merge chain and moves what is left behind with
-- the same rules a live merge uses (`merge_segment_memberships`, migration 0069):
--
--   * `segment_list_members` keeps the earliest addition and its provenance, and collapses a
--     duplicate when the survivor was already on the list;
--   * `segment_memberships` keeps the earliest `since` and deduplicates the same way;
--   * dynamic memberships are derived from the rule and are left for the next refresh, which
--     recomputes the survivor from its merged traits.
--
-- The chain walk mirrors `mergeComponentCtes` in packages/artifacts/src/mergeComponent.ts: 256
-- hops, a cycle resolves to its lowest id ("C" collation, as there), and a chain longer than the
-- bound resolves to the profile itself and is left alone rather than moved onto a guess. A profile
-- whose representative is still merged (a corrupted cycle, or a chain past the bound) is skipped
-- for the same reason. The pass is idempotent: a second run finds nothing left to move, or moves
-- nothing new.
DO $$
DECLARE
  w record;
  r record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);
    FOR r IN
      WITH RECURSIVE walk(origin, node, depth) AS (
        -- Only people who left a row behind: a tombstone with no membership in either table has
        -- nothing to repair, so it is not worth walking.
        SELECT p.id, p.id, 0
        FROM profiles p
        WHERE p.workspace_id = w.id AND p.merged_into IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM segment_memberships m
              WHERE m.workspace_id = w.id AND m.profile_id = p.id
            )
            OR EXISTS (
              SELECT 1 FROM segment_list_members l
              WHERE l.workspace_id = w.id AND l.profile_id = p.id
            )
          )
        UNION ALL
        SELECT walk.origin, p.merged_into, walk.depth + 1
        FROM walk
        JOIN profiles p ON p.workspace_id = w.id AND p.id = walk.node
        WHERE p.merged_into IS NOT NULL AND walk.depth < 256
      ) CYCLE node SET is_cycle USING cycle_path,
      representative(origin, representative, truncated) AS (
        SELECT walk.origin,
          CASE
            WHEN walk.is_cycle
              THEN (SELECT min(cycle.node COLLATE "C")
                      FROM unnest(walk.cycle_path[array_position(walk.cycle_path, ROW(walk.node)):]) AS cycle(node text))
            WHEN walk.depth >= 256 AND p.merged_into IS NOT NULL THEN walk.origin
            ELSE walk.node
          END,
          (NOT walk.is_cycle AND walk.depth >= 256 AND p.merged_into IS NOT NULL)
        FROM walk
        LEFT JOIN profiles p ON p.workspace_id = w.id AND p.id = walk.node
        WHERE walk.is_cycle OR walk.depth >= 256 OR p.merged_into IS NULL
      )
      SELECT rep.origin AS from_id, rep.representative COLLATE "default" AS root
      FROM representative rep
      JOIN profiles p ON p.workspace_id = w.id AND p.id = rep.representative COLLATE "default"
      JOIN profiles origin ON origin.workspace_id = w.id AND origin.id = rep.origin
      WHERE NOT rep.truncated AND p.merged_into IS NULL
      -- Replay the merges in the order they happened: a person folded away updated_at was set then,
      -- and the survivor's earliest-addition rule is applied in turn, so the provenance this pass
      -- settles on is the one the live merges would have produced.
      ORDER BY origin.updated_at, rep.origin
    LOOP
      PERFORM merge_segment_memberships(r.from_id, r.root);
    END LOOP;
  END LOOP;
END $$;
