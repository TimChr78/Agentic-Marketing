-- Wave 4, Phase 18 (#226): sponsor notifications and agent digests.
--
-- The scheduler reads the agent action ledger from a stored cursor, so each decision is announced
-- once. One row per workspace also records when the sponsor last received a daily digest, and which
-- mandate expiries were already announced (artifactId:version:validUntil in expiry_notified).
CREATE TABLE agent_notification_cursor (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  last_action_id bigint NOT NULL DEFAULT 0,
  last_digest_at timestamptz,
  expiry_notified jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE agent_notification_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_notification_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_notification_cursor
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agent_notification_cursor TO am_app;
