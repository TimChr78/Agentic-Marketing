-- 0.2.1 (issue #103): consent conditions in segments now follow the shared consent rule (ADR 0014),
-- so a withdrawal on one channel (an unsubscribe writes channel 'email') ends membership.
-- Forgetting the last run of every segment that tests consent (directly or through another
-- segment) makes the segment scheduler recompute it on its next round, which corrects existing
-- memberships and emits "Segment Exited" for the people who leave.
DELETE FROM segment_runs r
USING artifacts a
JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
WHERE a.workspace_id = r.workspace_id AND a.id = r.segment_id AND a.type = 'segment'
  AND v.content::text ~ '"(consent|segment)":';
