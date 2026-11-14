-- One active mandate per agent (#911). 0.14.17 serialised *new* mandate publishes (the
-- `am.agent-mandate` validator lock, #871) but shipped no repair for the race it closed: a
-- workspace that hit it kept two published, unarchived mandates for one agent forever. The
-- application then silently picked one (`activeMandates`: newest updated_at among published
-- mandates whose validUntil is in the future, so an expired mandate never beats a valid one) and
-- the ignored loser still blocked "archive it first" flows.
--
-- Keep exactly the mandate `activeMandates` picks today and archive the rest, the same way
-- migration 0092 archives a duplicate singleton: `archived = true`, `updated_at = now()`, and the
-- name gains " (archived duplicate <id>)" so an operator can tell them apart. Versions, approvals
-- and audit history stay readable. Mandates of different agents (and of the same agent id in
-- another workspace) are separate groups and are not touched.
--
-- The agent id lives in the published version's JSON content (`content->>'agent'`), and the expiry
-- in `content->>'validUntil'`. A value that is not a timestamp cannot win (`pg_input_is_valid`
-- keeps the cast safe), and when every published mandate for an agent has expired the newest one
-- is kept anyway: there is still only one row left for the agent to renew.
--
-- artifacts and artifact_versions FORCE row-level security. A migration role that is not a
-- superuser and has no BYPASSRLS would see no rows here, so the repair would silently do nothing;
-- read and write as the table owner with FORCE off for these statements, then turn it back on
-- before the migration commits (as 0092, 0072 and 0093 do).
ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions NO FORCE ROW LEVEL SECURITY;

-- Report per workspace before the repair, so an operator can see where two mandates were live.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT workspace_id, count(*) FILTER (WHERE position > 1)::int AS extra
      FROM (
        SELECT a.workspace_id,
               row_number() OVER (
                 PARTITION BY a.workspace_id, v.content->>'agent'
                 ORDER BY (
                   CASE
                     WHEN pg_input_is_valid(v.content->>'validUntil', 'timestamptz')
                       THEN (v.content->>'validUntil')::timestamptz
                   END
                 ) > now() DESC NULLS LAST,
                 a.updated_at DESC,
                 a.id DESC
               ) AS position
          FROM artifacts a
          JOIN artifact_versions v
            ON v.workspace_id = a.workspace_id
           AND v.artifact_id = a.id
           AND v.number = a.published_version
         WHERE a.type = 'agent_mandate'
           AND a.archived = false
           AND a.published_version IS NOT NULL
           AND v.content->>'agent' IS NOT NULL
      ) ranked
     GROUP BY workspace_id
    HAVING count(*) FILTER (WHERE position > 1) > 0
  LOOP
    RAISE NOTICE 'single active mandate repair: workspace % archived % extra mandate(s)', r.workspace_id, r.extra;
  END LOOP;
END $$;

WITH ranked AS (
  SELECT a.workspace_id,
         a.id,
         row_number() OVER (
           PARTITION BY a.workspace_id, v.content->>'agent'
           ORDER BY (
             CASE
               WHEN pg_input_is_valid(v.content->>'validUntil', 'timestamptz')
                 THEN (v.content->>'validUntil')::timestamptz
             END
           ) > now() DESC NULLS LAST,
           a.updated_at DESC,
           a.id DESC
         ) AS position
    FROM artifacts a
    JOIN artifact_versions v
      ON v.workspace_id = a.workspace_id
     AND v.artifact_id = a.id
     AND v.number = a.published_version
   WHERE a.type = 'agent_mandate'
     AND a.archived = false
     AND a.published_version IS NOT NULL
     AND v.content->>'agent' IS NOT NULL
)
UPDATE artifacts a
   SET archived = true,
       name = a.name || ' (archived duplicate ' || a.id || ')',
       updated_at = now()
  FROM ranked r
 WHERE a.workspace_id = r.workspace_id
   AND a.id = r.id
   AND r.position > 1;

ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions FORCE ROW LEVEL SECURITY;
