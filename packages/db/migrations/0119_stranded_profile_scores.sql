-- 0.17.6 (#1144): scores stranded by a merge that ran before this release.
--
-- `merge()` now moves a person's `profile_scores` to the survivor (#1144), but a merge that ran
-- earlier left the rows on the merged-away profile. Segmentation, journeys, `profiles.scores` and
-- `ai.calibration` all read the canonical id, so a stranded score is invisible to the person it
-- belongs to, and calibration counts it as a prediction whose identifiers all moved away.
--
-- `merge_profile_scores` is the rule a live merge applies, moved here so both paths share it: the
-- newer score per key wins (`created_at`; an exact tie keeps the survivor's row, as the live merge
-- does), and the source rows go. `resolve.ts` calls this function.
CREATE FUNCTION merge_profile_scores(p_from text, p_into text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'no workspace'; END IF;
  IF p_from = p_into THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE workspace_id = ws AND id = p_from)
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE workspace_id = ws AND id = p_into) THEN
    RAISE EXCEPTION 'profile is not in this workspace';
  END IF;

  INSERT INTO profile_scores
    (workspace_id, profile_id, key, value, confidence, probabilities, model, model_version, call_id, created_at, expires_at)
  SELECT workspace_id, p_into, key, value, confidence, probabilities, model, model_version, call_id, created_at, expires_at
  FROM profile_scores
  WHERE workspace_id = ws AND profile_id = p_from
  ON CONFLICT (workspace_id, profile_id, key) DO UPDATE SET
    value = EXCLUDED.value,
    confidence = EXCLUDED.confidence,
    probabilities = EXCLUDED.probabilities,
    model = EXCLUDED.model,
    model_version = EXCLUDED.model_version,
    call_id = EXCLUDED.call_id,
    created_at = EXCLUDED.created_at,
    expires_at = EXCLUDED.expires_at
  WHERE EXCLUDED.created_at > profile_scores.created_at;
  DELETE FROM profile_scores WHERE workspace_id = ws AND profile_id = p_from;
END $$;
REVOKE ALL ON FUNCTION merge_profile_scores(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_profile_scores(text, text) TO am_app;

-- One-off repair for the merges that ran before this release: resolve each tombstone that still
-- holds a score to the end of its chain and move what was left behind with the same function. The
-- chain walk mirrors migration 0117 (and `mergeComponentCtes` in packages/artifacts): 256 hops, a
-- cycle resolves to its lowest id ("C" collation, as there), and a chain longer than the bound
-- resolves to the profile itself and is left alone rather than moved onto a guess. A workspace is
-- repaired under its identity lock, the lock every merge and consent writer takes, so a merge
-- cannot fold a chain between the walk and the move.
DO $$
DECLARE
  w record;
  r record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);
    PERFORM pg_advisory_xact_lock(hashtextextended('identity:' || w.id::text, 0));
    FOR r IN
      WITH RECURSIVE walk(origin, node, depth) AS (
        -- Only people who left a score behind: a tombstone with none has nothing to repair.
        SELECT p.id, p.id, 0
        FROM profiles p
        WHERE p.workspace_id = w.id AND p.merged_into IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM profile_scores s
            WHERE s.workspace_id = w.id AND s.profile_id = p.id
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
      -- Replay the merges in the order they happened, like 0117: a person folded away had
      -- updated_at set then, so the survivor wins an exact `created_at` tie as it would have live.
      ORDER BY origin.updated_at, rep.origin
    LOOP
      PERFORM merge_profile_scores(r.from_id, r.root);
    END LOOP;
  END LOOP;
END $$;
