-- Password reset delivery outbox (#379). A reset request now records the link to send and answers
-- at once; the delivery worker sends it with bounded retries. The response therefore never waits
-- for a provider call and no longer differs between known, unknown and single sign-on addresses.
--
-- The row holds only what is needed to send: the account, the client IP for the audit entry, and
-- the reset token sealed with the sender workspace's data key (a dump of this table never yields a
-- usable link, like the hashed token in Better Auth's verification table). The sealed token is
-- wiped when the row reaches a terminal state; only the outcome remains for operators.
CREATE TABLE password_reset_deliveries (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ip text NOT NULL,
  token_sealed bytea,
  token_key_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_sealed IS NULL) = (token_key_id IS NULL))
);

CREATE INDEX password_reset_deliveries_due
  ON password_reset_deliveries (next_attempt_at)
  WHERE status = 'queued';

CREATE INDEX password_reset_deliveries_settled
  ON password_reset_deliveries (updated_at)
  WHERE status IN ('sent', 'failed');

ALTER TABLE password_reset_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON password_reset_deliveries
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_deliveries TO am_app;
