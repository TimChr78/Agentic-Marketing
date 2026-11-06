-- Indexes for the agent reads that grew with the ledger (#488).
-- agents.runFailures filters failed runs across every agent, newest first; the existing
-- (workspace_id, agent_id, started_at) index cannot serve the status filter or that order.
CREATE INDEX IF NOT EXISTS hosted_agent_runs_status_started
  ON hosted_agent_runs (workspace_id, status, started_at DESC, id);

-- agents.report counts one agent's contact-pressure skips in a period; the
-- (workspace_id, profile_id, created_at) index in 0076 does not lead with agent_id.
CREATE INDEX IF NOT EXISTS messages_agent_contact_count
  ON messages (workspace_id, agent_id, created_at)
  WHERE agent_id IS NOT NULL;
