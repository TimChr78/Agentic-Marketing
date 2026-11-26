-- am:no-transaction
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
-- repeats the three repairs. It runs outside one wrapping transaction on purpose: the identity
-- locks below must be taken *before* the FORCE lift takes its ACCESS EXCLUSIVE lock on
-- `workspaces`, because live ingestion takes the identity lock first and then needs `workspaces`
-- through a foreign key. Holding the workspace lock while waiting for the identity lock is the
-- 40P01 inversion. The two statements are separate transactions, with the ids kept in a temporary
-- table; each statement commits or rolls back as a whole, and a retry is safe because the repairs
-- are idempotent.
--
-- A SUPERUSER or BYPASSRLS migrator already ran the 0117–0119 repairs, so this file does nothing at
-- all for it: no ALTER and no lock.
DO $$
DECLARE
  bypass boolean;
BEGIN
  SELECT (r.rolsuper OR r.rolbypassrls) INTO bypass FROM pg_roles r WHERE r.rolname = current_user;
  IF bypass THEN
    -- A previous owner-only attempt in this session may have left the id table behind; never let a
    -- bypassing replay pick it up, and take no lock on `workspaces`.
    DROP TABLE IF EXISTS pg_temp.am_0122_workspaces;
    DROP TABLE IF EXISTS pg_temp.am_0122_plan;
    RETURN;
  END IF;

  -- Statement 1: read the workspace ids once, with a short exclusive lock that no identity lock is
  -- held behind. Ingestion that already holds an identity lock only waits for this statement, and
  -- this statement never waits for an identity lock, so there is no cycle.
  EXECUTE 'ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY';
  DROP TABLE IF EXISTS pg_temp.am_0122_workspaces;
  CREATE TEMPORARY TABLE am_0122_workspaces (id uuid PRIMARY KEY);
  INSERT INTO am_0122_workspaces (id) SELECT id FROM workspaces;
  EXECUTE 'ALTER TABLE workspaces FORCE ROW LEVEL SECURITY';
END $$;

-- Statement 2: an owner-only replay. The identity locks are taken first, in the order ingestion
-- takes them, so a live merge can finish before the FORCE lift asks for `workspaces`.
DO $$
DECLARE
  w record;
  r record;
BEGIN
  IF to_regclass('pg_temp.am_0122_workspaces') IS NULL THEN
    RETURN;
  END IF;

  FOR w IN SELECT id FROM am_0122_workspaces ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('identity:' || w.id::text, 0));
  END LOOP;

  EXECUTE 'ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY';

  -- 0117's repair: static-list and materialised membership rows stranded on a merged-away profile
  -- (#1102), through the same `merge_segment_memberships` function a live merge uses.
  FOR w IN SELECT id FROM am_0122_workspaces ORDER BY id LOOP
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

  -- 0118's repair: ad-conversion delivery keys written before 0.17.6 gained the destination's
  -- action (#1155). A profiles batch redelivered after the upgrade computes the new key and queues a
  -- second conversion unless the old row is rewritten; the new-format duplicate is deleted.
  --
  -- 0118 compared keys only, and that loses a delivery: two legacy rows on one connection with
  -- event ids `msg` and `purchase:msg` give the second row the old key
  -- `adc:meta:conn:purchase:msg`, which is exactly the first row's new key. Treating a key match as
  -- a duplicate deleted the `msg` delivery. 0118 is already applied and is not edited; this replay
  -- does not repeat the flaw: a row is a duplicate only when it has the same event id and the same
  -- destination action. The rewrites are staged first, because rewriting the `msg` row in place
  -- would collide with the `purchase:msg` row's still-legacy key under the UNIQUE constraint.
  CREATE TEMPORARY TABLE IF NOT EXISTS am_0122_plan (
    workspace_id uuid NOT NULL,
    id text NOT NULL,
    event_id text,
    dest_action text,
    new_key text NOT NULL,
    PRIMARY KEY (workspace_id, id)
  ) ON COMMIT DELETE ROWS;

  FOR w IN SELECT id FROM am_0122_workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);

    INSERT INTO am_0122_plan (workspace_id, id, event_id, dest_action, new_key)
    SELECT d.workspace_id,
           d.id,
           d.payload->>'eventId',
           COALESCE(
             d.payload->'destination'->>'conversionAction',
             d.payload->'destination'->>'eventName',
             d.payload->'destination'->>'conversionName',
             d.payload->'destination'->>'conversionId',
             d.payload->'destination'->>'event',
             ''
           ),
           'adc:' || d.action || ':' || d.target_id || ':' ||
             COALESCE(
               d.payload->'destination'->>'conversionAction',
               d.payload->'destination'->>'eventName',
               d.payload->'destination'->>'conversionName',
               d.payload->'destination'->>'conversionId',
               d.payload->'destination'->>'event',
               ''
             ) || ':' || (d.payload->>'eventId')
    FROM deliveries d
    WHERE d.workspace_id = w.id
      AND d.kind = 'ad_conversion'
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId');

    -- Stage every legacy row under a per-row key. This is what lets overlapping keys move: the
    -- `msg` row may take the key the `purchase:msg` row is about to leave.
    UPDATE deliveries d
    SET idempotency_key = 'adc-legacy-stage:' || d.id
    FROM am_0122_plan p
    WHERE p.workspace_id = w.id AND d.workspace_id = p.workspace_id AND d.id = p.id
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId');

    DELETE FROM deliveries d
    USING am_0122_plan p
    WHERE p.workspace_id = w.id AND d.workspace_id = p.workspace_id AND d.id = p.id
      AND d.idempotency_key = 'adc-legacy-stage:' || d.id
      AND EXISTS (
        SELECT 1
        FROM deliveries n
        WHERE n.workspace_id = d.workspace_id
          AND n.kind = 'ad_conversion'
          AND n.id <> d.id
          AND n.payload->>'eventId' = p.event_id
          AND COALESCE(
                n.payload->'destination'->>'conversionAction',
                n.payload->'destination'->>'eventName',
                n.payload->'destination'->>'conversionName',
                n.payload->'destination'->>'conversionId',
                n.payload->'destination'->>'event',
                ''
              ) = p.dest_action
          AND n.idempotency_key = p.new_key
      );

    UPDATE deliveries d
    SET idempotency_key = p.new_key
    FROM am_0122_plan p
    WHERE p.workspace_id = w.id AND d.workspace_id = p.workspace_id AND d.id = p.id
      AND d.idempotency_key = 'adc-legacy-stage:' || d.id;

    DELETE FROM am_0122_plan WHERE workspace_id = w.id;
  END LOOP;

  -- 0119's repair: scores stranded on a merged-away profile (#1144), through the
  -- `merge_profile_scores` function 0119 created.
  FOR w IN SELECT id FROM am_0122_workspaces ORDER BY id LOOP
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

  EXECUTE 'ALTER TABLE workspaces FORCE ROW LEVEL SECURITY';
  DROP TABLE IF EXISTS pg_temp.am_0122_plan;
  DROP TABLE IF EXISTS pg_temp.am_0122_workspaces;
END $$;
