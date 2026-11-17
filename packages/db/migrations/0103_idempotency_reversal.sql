-- #950: an idempotent replay returned the stored response forever, even after agents.undo had
-- reversed the action it described. A command can write several undoable ledger rows in one
-- transaction (config.import publishes each artifact through artifacts.requestPublish), so the
-- stored response names every row it describes; undo marks the key reversed when any is undone and
-- a replay then answers 409.
ALTER TABLE idempotency_keys ADD COLUMN reversed_at timestamptz;

CREATE TABLE idempotency_key_actions (
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  agent_action_id bigint NOT NULL,
  PRIMARY KEY (workspace_id, key, agent_action_id),
  FOREIGN KEY (workspace_id, key) REFERENCES idempotency_keys (workspace_id, key) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_action_id) REFERENCES agent_actions (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE idempotency_key_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_key_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON idempotency_key_actions TO am_app;

COMMENT ON COLUMN idempotency_keys.reversed_at IS
  'When the agent action behind this stored response was undone; a replay answers 409 (#950).';
COMMENT ON TABLE idempotency_key_actions IS
  'The agent ledger rows a stored idempotent response describes; undoing any of them reverses the key (#950).';
