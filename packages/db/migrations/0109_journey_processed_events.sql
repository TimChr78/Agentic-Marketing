-- #1011: the journey hook applies one event once.
--
-- The hook runs after the batch that resolved the events. Delivery is at-least-once, so the same
-- event can be handed to it twice: enrolment used to rely on the active-only entry key, which stops
-- blocking once the participant has exited or completed, so an `after_exit` journey could enrol the
-- same event again (two participants for one event) and a redelivered event could wake a wait that
-- an earlier delivery of that same event created.
--
-- One row per event that enrolled someone closes both: the hook skips an event whose row exists, so
-- the enrolment and the wake-up the event caused are applied exactly once. Events that enrolled
-- nobody write no row, so the table only grows with the journeys' actual entries.
CREATE TABLE IF NOT EXISTS journey_processed_events (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- The ingestion message id of the event (evt_…): unique per delivery, and what the hook is given.
  -- It is caller-supplied, so it can name the person (an address, an order key); see profile_id.
  event_id text NOT NULL,
  -- The person the event enrolled (the canonical profile at that moment). Erasing the family removes
  -- these markers with the rest of the person's rows.
  profile_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, event_id)
);

-- An erasure deletes a family's markers; the retention round prunes by age in bounded batches.
CREATE INDEX IF NOT EXISTS journey_processed_events_profile ON journey_processed_events (workspace_id, profile_id);
CREATE INDEX IF NOT EXISTS journey_processed_events_processed ON journey_processed_events (processed_at);

ALTER TABLE journey_processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_processed_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journey_processed_events;
CREATE POLICY tenant_isolation ON journey_processed_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- The hook reads and writes markers; an erasure deletes the person's (their event ids can name them),
-- so the app role needs DELETE on rows of its own workspace (#1011 review).
GRANT SELECT, INSERT, DELETE ON journey_processed_events TO am_app;

COMMENT ON TABLE journey_processed_events IS
  'Events whose journey enrolment already committed (#1011); a redelivered event is not applied twice.';
COMMENT ON COLUMN journey_processed_events.event_id IS
  'The ingestion message id (evt_…). A new event, even for the same person and journey, is a new row.';
COMMENT ON COLUMN journey_processed_events.profile_id IS
  'The person the event enrolled, so an erasure removes their markers; the event id itself may name them.';
COMMENT ON COLUMN journey_processed_events.processed_at IS
  'When the enrolment committed; the retention round prunes markers older than the event replay window.';
