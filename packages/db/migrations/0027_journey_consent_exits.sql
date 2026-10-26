-- 0.2.3 (issue #108): people who refused a journey's purpose leave the journey. Consent changes
-- now exit them at once; this exits the participants who are already waiting. The current status
-- follows the shared rule without a channel (ADR 0014): a refusal on any channel at least as new
-- as the all-channels row wins. Contract and legal obligation purposes never stop.
UPDATE journey_participants p
SET status = 'exited', error = 'consent_withdrawn: ' || (v.content->>'purpose'), due_at = NULL, waiting_event = NULL,
  updated_at = now()
FROM artifact_versions v
WHERE v.workspace_id = p.workspace_id AND v.artifact_id = p.journey_id AND v.number = p.version
  AND p.status IN ('ready', 'waiting')
  AND EXISTS (
    SELECT 1 FROM (
      SELECT c.status, c.basis FROM consent_state c
      WHERE c.workspace_id = p.workspace_id AND c.profile_id = p.profile_id AND c.purpose = v.content->>'purpose'
        AND (c.channel = '' OR c.updated_at >= coalesce((SELECT a.updated_at FROM consent_state a
          WHERE a.workspace_id = c.workspace_id AND a.profile_id = c.profile_id AND a.purpose = c.purpose AND a.channel = ''),
          '-infinity'::timestamptz))
      ORDER BY (c.status IN ('withdrawn', 'objected', 'denied')) DESC, c.updated_at DESC
      LIMIT 1
    ) cur
    WHERE cur.status IN ('withdrawn', 'objected', 'denied') AND cur.basis IN ('consent', 'legitimate_interest'));

-- Consent changes look up a person's active participants.
CREATE INDEX IF NOT EXISTS journey_participants_profile ON journey_participants (workspace_id, profile_id) WHERE status IN ('ready', 'waiting');
