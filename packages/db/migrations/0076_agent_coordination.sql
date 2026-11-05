-- Several agents in one workspace (#426): which agent owns an artifact, and which agent put a
-- marketing message in front of a person. Both are nullable and additive: existing artifacts and
-- messages keep working, and a deleted agent leaves its id behind so the ownership can still be
-- reported (a missing agent counts as retired, never as an active owner).
ALTER TABLE artifacts ADD COLUMN owner_agent_id text;
ALTER TABLE messages ADD COLUMN agent_id text;

-- #184: a brand is a workspace, so this reserved column stays unused.
COMMENT ON COLUMN agents.brand IS 'Reserved (#184): a brand is a workspace; unused.';

-- The owner list on an agent's report.
CREATE INDEX artifacts_owner_agent ON artifacts (workspace_id, owner_agent_id)
  WHERE owner_agent_id IS NOT NULL;

-- Cross-agent contact pressure counts one person's agent-originated messages in a window.
CREATE INDEX messages_agent_contact ON messages (workspace_id, profile_id, created_at)
  WHERE agent_id IS NOT NULL;
