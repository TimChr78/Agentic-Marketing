-- Transactional outbox (#978 part 2).
--
-- A transaction that implies network work (a message decision event for ClickHouse, a double
-- opt-in confirmation send) writes one row here instead of doing the I/O while it holds its
-- locks. A dispatcher claims a small batch with a short lease, commits, performs the I/O outside
-- any transaction and then acknowledges the row. A process that dies after the claim redelivers
-- the row when the lease expires, so delivery is at-least-once: the stable ids in the payload
-- make the second delivery harmless (message events collapse on their ClickHouse key, a DOI send
-- replays on its message idempotency key).
--
-- `operation_key` is unique per workspace and makes enqueueing idempotent: a redelivered ingest
-- batch or a retried route writes no second row for the same action.
CREATE TABLE IF NOT EXISTS outbox (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  operation_key text NOT NULL,
  -- The broadcast or journey these events belong to, so a decision can tell whether its own
  -- publication is still pending without scanning the payload.
  subject_ref text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- The token of the current claim. Every claim writes a fresh one, and completion only applies
  -- while it still matches, so a dispatcher whose lease expired cannot overwrite the new owner's
  -- result.
  claim_token text,
  -- Why a row is dead-lettered: 'permanent' (a payload no version can deliver) or 'exhausted'
  -- (transient failures used their attempt budget). Requeue skips permanent failures by default.
  failure_kind text CHECK (failure_kind IN ('permanent', 'exhausted')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, operation_key)
);

-- The dispatcher's claim reads only rows that are due and still pending (or whose lease expired).
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox (next_attempt_at, created_at)
  WHERE state IN ('pending', 'delivering');
-- Delivered rows are pruned long after the work settled; this keeps the prune cheap.
CREATE INDEX IF NOT EXISTS outbox_delivered ON outbox (delivered_at) WHERE state = 'delivered';
-- The publication barrier asks whether events for one broadcast/journey are still undelivered.
CREATE INDEX IF NOT EXISTS outbox_undelivered_subject ON outbox (subject_ref)
  WHERE state IN ('pending', 'delivering');
-- A decision proceeds when only failed rows remain; this finds them without a delivered-row scan.
CREATE INDEX IF NOT EXISTS outbox_failed_subject ON outbox (subject_ref) WHERE state = 'failed';

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbox;
CREATE POLICY tenant_isolation ON outbox
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox TO am_app;

COMMENT ON TABLE outbox IS
  'Durable queue of post-commit work a tenant transaction implies (#978 part 2); delivered rows are pruned.';
COMMENT ON COLUMN outbox.operation_key IS
  'Stable id of the action this row delivers; unique per workspace so a redelivery enqueues nothing new.';
COMMENT ON COLUMN outbox.subject_ref IS
  'Broadcast or journey whose events this row publishes; a decision defers while its rows are undelivered.';
COMMENT ON COLUMN outbox.claim_token IS
  'Token of the current claim; ack and fail only apply while it matches, fencing an expired claim.';
COMMENT ON COLUMN outbox.failure_kind IS
  'permanent (an undeliverable payload) or exhausted (transient retries used their budget); requeue skips permanent rows.';
