-- Operational reliability (0.7.4): enrollment chunk retries (#370) and OAuth refresh leases (#376).
-- Number 0072 is reserved for the separate audience-reconciliation workstream.
--
-- #370: a chunk that fails on a deadlock, statement timeout or dropped connection is retried with
-- backoff instead of failing the whole backfill. The cursor, counts and pinned artifact versions
-- are committed by the previous chunk, so retry state must live beside them: `attempts` counts
-- consecutive transient chunk failures (reset by a chunk that commits) and `next_attempt_at`
-- is when the scheduler may try the job again. Permanent artifact/schema failures still move the
-- job to `failed` immediately.
ALTER TABLE enrollment_jobs
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz;

CREATE INDEX enrollment_jobs_retry
  ON enrollment_jobs (next_attempt_at)
  WHERE status IN ('queued', 'running');

-- #376: rotating refresh tokens (Microsoft, Salesforce, LinkedIn and similar providers) invalidate
-- the old token as soon as one is redeemed. Two scheduler replicas must not refresh the same
-- connection concurrently, and the HTTP exchange must not hold an app transaction. A short lease
-- is claimed and committed before the request; `oauth_refresh_lease_token` identifies the owner so
-- a result is only written back (or an invalid_grant recorded) while it still owns the lease and
-- the connection has not been re-authorized or disabled meanwhile.
ALTER TABLE connections
  ADD COLUMN oauth_refresh_lease_until timestamptz,
  ADD COLUMN oauth_refresh_lease_token text;

CREATE INDEX connections_oauth_refresh_lease
  ON connections (oauth_refresh_lease_until)
  WHERE oauth_status = 'connected' AND enabled;

COMMENT ON COLUMN connections.oauth_refresh_lease_until IS
  'Until when the holder of oauth_refresh_lease_token may refresh; null means no refresh in flight.';

-- #368: the bounded reconciliation sweep looks for ledger entries still marked queued (including
-- for resolved or disabled rules). The GIN index keeps that scan proportional to the queued rows
-- instead of every firing episode in the workspace.
CREATE INDEX alert_events_notified ON alert_events USING gin (notified jsonb_path_ops);
