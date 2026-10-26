-- Phase 13 (#109): retries are scheduled per message. A failed confirmation or account message
-- can then be retried in seconds while marketing keeps the slower backoff. NULL means a queued
-- row from before this migration (or one held by not_before): the claim falls back to updated_at.
ALTER TABLE messages ADD COLUMN next_attempt_at timestamptz;

-- The claim query picks queued rows per workspace by next_attempt_at. messages_queued still
-- serves the worker's "which workspaces have queued work" scan.
CREATE INDEX messages_retry ON messages (workspace_id, next_attempt_at) WHERE status = 'queued';
