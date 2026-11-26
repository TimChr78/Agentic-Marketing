-- 0.17.8 (#1218): repeat the 0117, 0118 and 0119 repairs for a migration role that owns the
-- tables but cannot bypass row-level security.
--
-- Those three files loop over `SELECT id FROM workspaces` to set `app.workspace_id` per tenant.
-- `workspaces` is ENABLE + FORCE ROW LEVEL SECURITY, so a non-superuser table owner without
-- BYPASSRLS — the small-install migrator AGENTS.md and the migration tests describe — reads zero
-- workspaces, does nothing, and the file is then recorded as applied. The repairs can never run
-- again on that install. `am restore` replays migrations as the restoring role too.
--
-- This pass reads the workspace ids with FORCE briefly off (as 0072, 0083 and 0087 do) and then
-- repeats the three repairs inside one transaction: the lift is rolled back with a failure, and
-- each repair is idempotent, so a database that already ran them as a superuser changes nothing.
ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;

-- 0117's repair: static-list and materialised membership rows stranded on a merged-away profile
-- (#1102), through the same `merge_segment_memberships` function a live merge uses.
DO $$
DECLARE
  w record;
  r record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);
    FOR r IN
      WITH RECURSIVE walk(origin, node, depth) AS (
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
      ORDER BY origin.updated_at, rep.origin
    LOOP
      PERFORM merge_segment_memberships(r.from_id, r.root);
    END LOOP;
  END LOOP;
END $$;

-- 0118's repair: ad-conversion delivery keys written before 0.17.6 gained the destination's
-- action (#1155). A profiles batch redelivered after the upgrade computes the new key and queues a
-- second conversion unless the old row is rewritten; the new-format duplicate is deleted.
DO $$
DECLARE
  w record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);

    DELETE FROM deliveries d
    WHERE d.workspace_id = w.id
      AND d.kind = 'ad_conversion'
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId')
      AND EXISTS (
        SELECT 1
        FROM deliveries n
        WHERE n.workspace_id = d.workspace_id
          AND n.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
            COALESCE(
              d.payload->'destination'->>'conversionAction',
              d.payload->'destination'->>'eventName',
              d.payload->'destination'->>'conversionName',
              d.payload->'destination'->>'conversionId',
              d.payload->'destination'->>'event',
              ''
            ) || ':' || (d.payload->>'eventId')
      );

    UPDATE deliveries d
    SET idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
      COALESCE(
        d.payload->'destination'->>'conversionAction',
        d.payload->'destination'->>'eventName',
        d.payload->'destination'->>'conversionName',
        d.payload->'destination'->>'conversionId',
        d.payload->'destination'->>'event',
        ''
      ) || ':' || (d.payload->>'eventId')
    WHERE d.workspace_id = w.id
      AND d.kind = 'ad_conversion'
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId')
      AND NOT EXISTS (
        SELECT 1
        FROM deliveries n
        WHERE n.workspace_id = d.workspace_id
          AND n.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
            COALESCE(
              d.payload->'destination'->>'conversionAction',
              d.payload->'destination'->>'eventName',
              d.payload->'destination'->>'conversionName',
              d.payload->'destination'->>'conversionId',
              d.payload->'destination'->>'event',
              ''
            ) || ':' || (d.payload->>'eventId')
      );
  END LOOP;
END $$;

-- 0119's repair: scores stranded on a merged-away profile (#1144), through the
-- `merge_profile_scores` function 0119 created.
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
      ORDER BY origin.updated_at, rep.origin
    LOOP
      PERFORM merge_profile_scores(r.from_id, r.root);
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
