-- Wave 4, Phase 20 (#276): per-action delivery for sponsor notifications.
--
-- A hold, escalation or refusal is announced to every recipient once. The batch an e-mail contains
-- may change between sweeps (a retry after a failure, or a new action for the same agent), so a
-- batch-wide idempotency key cannot say what a recipient already received. One row per action and
-- recipient records that, and the cursor only advances past actions delivered to everyone.
CREATE TABLE agent_notification_deliveries (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  action_id bigint NOT NULL,
  user_id text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, action_id, user_id)
);

ALTER TABLE agent_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_notification_deliveries
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON agent_notification_deliveries TO am_app;
