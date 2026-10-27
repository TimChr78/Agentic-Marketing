-- Phase 15 (#88, #70): broadcast subject tests and recipient-local send windows.
--
-- A subject test sends 2–4 subject lines to a deterministic sample and, after decide_after, the
-- winner to the rest of the segment. The message records its variant (A, B, …) so results are
-- counted per subject; a broadcast has at most one test, keyed like its run.
--
-- Send windows hold each message until the next opening in the reader's own time zone by setting
-- messages.not_before; people whose next window starts after send_at + max_delay are skipped, and
-- the run counts them separately from other skips.

ALTER TABLE messages ADD COLUMN variant text;

CREATE TABLE broadcast_tests (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  broadcast_id text NOT NULL,
  subjects jsonb NOT NULL,
  sample_percent integer NOT NULL,
  metric text NOT NULL CHECK (metric IN ('click', 'open')),
  state text NOT NULL CHECK (state IN ('sampling', 'deciding', 'winner_sent')),
  -- Set when the first sample messages are queued; the rest goes out then (or as soon after as a
  -- send window allows).
  decide_at timestamptz,
  winner text,
  reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, broadcast_id)
);

ALTER TABLE broadcast_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcast_tests
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_tests TO am_app;

ALTER TABLE broadcast_runs ADD COLUMN window_skipped integer NOT NULL DEFAULT 0;

-- Results are counted per broadcast and variant; the partial index keeps that a range scan.
CREATE INDEX messages_variant ON messages (workspace_id, journey_id, variant) WHERE variant IS NOT NULL;
