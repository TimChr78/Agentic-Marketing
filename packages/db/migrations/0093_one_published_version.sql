-- Exactly one published version per artifact (#912). Until now that invariant rested on the
-- publish lock in the application (`publishVersion` locks the artifact before it reads the live
-- version), with no database backstop: a writer that publishes without the lock could leave two
-- versions in state `published` and nothing would notice the #868 class of bug returning.
--
-- Repair first, then constrain. For every artifact with more than one `published` version the
-- survivor is deterministic:
--   * the version `artifacts.published_version` points at, when it is one of them (the live one);
--   * otherwise the highest version number, which is what the artifact would have served had the
--     pointer been written last.
-- The others become `superseded` (history, not deleted). An artifact whose pointer names no
-- published version at all is pointed at the surviving one.
--
-- One version per artifact is all the index needs: `(workspace_id, artifact_id)` with
-- `state = 'published'` makes a second published row a 23505, which the executor answers as a
-- conflict (packages/commands/src/registry.ts, knownConflict).
--
-- artifact_versions FORCEs row-level security. A migration role that is not a superuser and has no
-- BYPASSRLS would see no rows here, so the repair would silently do nothing; read and write as the
-- table owner with FORCE off for these statements, then turn it back on before the migration
-- commits (as 0092 and 0072 do).
ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions NO FORCE ROW LEVEL SECURITY;

-- Report per workspace before the repair, so an operator can see where the invariant had drifted.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT workspace_id, count(*) FILTER (WHERE position > 1)::int AS extra
      FROM (
        SELECT v.workspace_id,
               row_number() OVER (
                 PARTITION BY v.workspace_id, v.artifact_id
                 ORDER BY (v.number = a.published_version) DESC, v.number DESC
               ) AS position
          FROM artifact_versions v
          JOIN artifacts a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
         WHERE v.state = 'published'
      ) ranked
     GROUP BY workspace_id
    HAVING count(*) FILTER (WHERE position > 1) > 0
  LOOP
    RAISE NOTICE 'one published version repair: workspace % had % extra published version(s)', r.workspace_id, r.extra;
  END LOOP;
END $$;

WITH ranked AS (
  SELECT v.workspace_id,
         v.artifact_id,
         v.number,
         row_number() OVER (
           PARTITION BY v.workspace_id, v.artifact_id
           ORDER BY (v.number = a.published_version) DESC, v.number DESC
         ) AS position
    FROM artifact_versions v
    JOIN artifacts a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
   WHERE v.state = 'published'
)
UPDATE artifact_versions av
   SET state = 'superseded',
       updated_at = now()
  FROM ranked r
 WHERE av.workspace_id = r.workspace_id
   AND av.artifact_id = r.artifact_id
   AND av.number = r.number
   AND r.position > 1;

-- A pointer that names no published version (null, or a superseded/draft one) is set to the
-- survivor, so `artifacts.published_version` and the published row agree again.
UPDATE artifacts a
   SET published_version = k.number,
       updated_at = now()
  FROM (
    SELECT v.workspace_id, v.artifact_id, max(v.number) AS number
      FROM artifact_versions v
     WHERE v.state = 'published'
     GROUP BY v.workspace_id, v.artifact_id
  ) k
 WHERE a.workspace_id = k.workspace_id
   AND a.id = k.artifact_id
   AND (
     a.published_version IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM artifact_versions pv
        WHERE pv.workspace_id = a.workspace_id
          AND pv.artifact_id = a.id
          AND pv.number = a.published_version
          AND pv.state = 'published'
     )
   );

ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_one_published
  ON artifact_versions (workspace_id, artifact_id)
  WHERE state = 'published';
