-- 0.7.2 (#395, #396): an identity merge must carry the person's topic choices and static/snapshot
-- list memberships to the survivor. Both tables are keyed by profile id, and the app role cannot
-- move them itself (topic_preferences has no DELETE grant, and list metadata needs a conditional
-- update). These functions are the app role's only way to move rows: they run as the owner, only
-- in the caller's workspace, and only for profiles that exist there.

-- Topic choices (#395). A topic choice is the person's own decision; after a merge the survivor
-- must see it even when the survivor had no row. Conflict rule: the most recent choice wins; on
-- an exact timestamp tie an opt-out wins, otherwise the survivor's row is kept. The source and
-- timestamp travel with the winning choice. topic_preference_history stays append-only on the
-- merged-away id: an export reads the whole merged family, so the evidence remains reachable and
-- erasure still removes it through the profile cascade.
CREATE FUNCTION merge_topic_preferences(p_from text, p_into text) RETURNS void
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
  INSERT INTO topic_preferences (workspace_id, profile_id, topic, status, source, updated_at)
  SELECT workspace_id, p_into, topic, status, source, updated_at
  FROM topic_preferences
  WHERE workspace_id = ws AND profile_id = p_from
  ON CONFLICT (workspace_id, profile_id, topic) DO UPDATE
  SET status = CASE
        WHEN excluded.updated_at > topic_preferences.updated_at THEN excluded.status
        WHEN excluded.updated_at < topic_preferences.updated_at THEN topic_preferences.status
        WHEN excluded.status = 'unsubscribed' THEN 'unsubscribed'
        ELSE topic_preferences.status END,
      source = CASE
        WHEN excluded.updated_at > topic_preferences.updated_at THEN excluded.source
        WHEN excluded.updated_at < topic_preferences.updated_at THEN topic_preferences.source
        WHEN excluded.status = 'unsubscribed' THEN excluded.source
        ELSE topic_preferences.source END,
      updated_at = GREATEST(topic_preferences.updated_at, excluded.updated_at);
  DELETE FROM topic_preferences WHERE workspace_id = ws AND profile_id = p_from;
END $$;
REVOKE ALL ON FUNCTION merge_topic_preferences(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_topic_preferences(text, text) TO am_app;

-- A merge looks up one person's list rows across all lists; the primary key starts with the
-- segment id, so it cannot serve that lookup.
CREATE INDEX segment_list_members_profile ON segment_list_members (workspace_id, profile_id);

-- Static/snapshot list memberships (#396). segment_list_members is the source of truth and
-- segment_memberships is the materialized copy every reader uses. Move both for list segments:
--   * source rows: keep the earliest addition and its provenance (added_by/source), deduplicate
--     when the survivor was already on the list;
--   * materialized rows: keep the earliest `since`, deduplicate the same way.
-- Dynamic memberships are derived from the rule, not owned by the list: they are left for the next
-- refresh, which recomputes the survivor from its merged traits. Moving them here could keep a
-- person in a rule segment their surviving traits no longer match.
CREATE FUNCTION merge_segment_memberships(p_from text, p_into text) RETURNS void
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

  INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, added_at, added_by, source)
  SELECT workspace_id, segment_id, p_into, added_at, added_by, source
  FROM segment_list_members
  WHERE workspace_id = ws AND profile_id = p_from
  ON CONFLICT (workspace_id, segment_id, profile_id) DO UPDATE
  SET added_at = LEAST(segment_list_members.added_at, excluded.added_at),
      added_by = CASE
        WHEN excluded.added_at < segment_list_members.added_at THEN excluded.added_by
        ELSE segment_list_members.added_by END,
      source = CASE
        WHEN excluded.added_at < segment_list_members.added_at THEN excluded.source
        ELSE segment_list_members.source END;
  DELETE FROM segment_list_members WHERE workspace_id = ws AND profile_id = p_from;

  INSERT INTO segment_memberships (workspace_id, segment_id, profile_id, since)
  SELECT m.workspace_id, m.segment_id, p_into, m.since
  FROM segment_memberships m
  WHERE m.workspace_id = ws AND m.profile_id = p_from
    AND (
      EXISTS (
        SELECT 1 FROM segment_list_members l
        WHERE l.workspace_id = ws AND l.segment_id = m.segment_id AND l.profile_id = p_into
      )
      OR EXISTS (
        SELECT 1
        FROM artifacts a
        JOIN artifact_versions v
          ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
        WHERE a.workspace_id = ws AND a.id = m.segment_id AND a.type = 'segment'
          AND a.published_version IS NOT NULL
          AND coalesce(v.content->>'mode', 'dynamic') <> 'dynamic'
      )
    )
  ON CONFLICT (workspace_id, segment_id, profile_id) DO UPDATE
  SET since = LEAST(segment_memberships.since, excluded.since);

  DELETE FROM segment_memberships m
  WHERE m.workspace_id = ws AND m.profile_id = p_from
    AND (
      EXISTS (
        SELECT 1 FROM segment_list_members l
        WHERE l.workspace_id = ws AND l.segment_id = m.segment_id AND l.profile_id = p_into
      )
      OR EXISTS (
        SELECT 1
        FROM artifacts a
        JOIN artifact_versions v
          ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
        WHERE a.workspace_id = ws AND a.id = m.segment_id AND a.type = 'segment'
          AND a.published_version IS NOT NULL
          AND coalesce(v.content->>'mode', 'dynamic') <> 'dynamic'
      )
    );
END $$;
REVOKE ALL ON FUNCTION merge_segment_memberships(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_segment_memberships(text, text) TO am_app;

-- One-off repair for people merged before this migration. Resolve each tombstone to its current
-- root (merges can chain) and move what the old merge left behind with the same rules. Dynamic
-- segment_memberships rows are intentionally not touched: they are derived, and the next segment
-- refresh removes the tombstone and recomputes the survivor. Historical choices stay in
-- topic_preference_history; this migration does not rewrite that append-only ledger.
DO $$
DECLARE
  w record;
  r record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);
    FOR r IN
      WITH RECURSIVE chain AS (
        SELECT p.workspace_id, p.id AS from_id, p.merged_into AS id, 1 AS depth
        FROM profiles p
        WHERE p.workspace_id = w.id AND p.merged_into IS NOT NULL
        UNION ALL
        SELECT c.workspace_id, c.from_id, p.merged_into, c.depth + 1
        FROM chain c
        JOIN profiles p ON p.workspace_id = c.workspace_id AND p.id = c.id
        WHERE p.merged_into IS NOT NULL AND c.depth < 20
      )
      SELECT c.from_id, c.id AS root
      FROM chain c
      JOIN profiles p ON p.workspace_id = c.workspace_id AND p.id = c.id
      WHERE p.merged_into IS NULL
    LOOP
      PERFORM merge_topic_preferences(r.from_id, r.root);
      PERFORM merge_segment_memberships(r.from_id, r.root);
    END LOOP;
  END LOOP;
END $$;
