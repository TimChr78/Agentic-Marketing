-- 0.2.10 (issue #169): reaching an Exit step now completes the journey; `exited` is kept for
-- leaving early (consent withdrawn, dropped in a migration), which always records a reason in
-- `error`. Participants who ended at an Exit step before this release were stored as `exited`
-- with no error: relabel them. Their past journey_events in ClickHouse keep the old type.
UPDATE journey_participants p
SET status = 'completed', updated_at = now()
FROM artifact_versions v
WHERE v.workspace_id = p.workspace_id AND v.artifact_id = p.journey_id AND v.number = p.version
  AND p.status = 'exited' AND p.error IS NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.content->'nodes') n
    WHERE n->>'id' = p.node AND n->>'kind' = 'exit');
