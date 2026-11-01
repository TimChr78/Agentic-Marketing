-- The copilot attached to an agent (#339): a conversation can act as an agent under its mandate.
-- The conversation records the agent, and the agent gets a `copilot` credential, so pausing or
-- revoking it stops its conversations like its other credentials, and its approvals, holds and
-- ledger entries are traced to it.
ALTER TABLE copilot_conversations ADD COLUMN agent_id text;
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_kind_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_kind_check CHECK (kind IN ('api_token', 'oauth_client', 'hosted', 'copilot'));
