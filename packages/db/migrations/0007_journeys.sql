-- Journey runtime (ADR-0004): the participants table is the work queue. Sweepers claim due rows
-- with FOR UPDATE SKIP LOCKED, advance them in memory and write state and sends in the same
-- transaction; side effects are keyed by (participant, node, seq).
CREATE TABLE journey_participants (
  workspace_id uuid NOT NULL,
  id bigserial,
  journey_id text NOT NULL,
  version integer NOT NULL,
  profile_id text NOT NULL,
  entry_key text NOT NULL,
  node text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'waiting', 'completed', 'exited', 'failed')),
  seq integer NOT NULL DEFAULT 0,
  due_at timestamptz,
  waiting_event text,
  matched boolean NOT NULL DEFAULT false,
  converted boolean NOT NULL DEFAULT false,
  context jsonb NOT NULL DEFAULT '{}',
  error text,
  entered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  -- The event that caused an entry enters the person once, however often it is delivered.
  UNIQUE (workspace_id, journey_id, entry_key),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
) WITH (fillfactor = 80);
CREATE INDEX journey_participants_due ON journey_participants (due_at) WHERE status IN ('ready', 'waiting');
CREATE INDEX journey_participants_waiting ON journey_participants (workspace_id, profile_id, waiting_event) WHERE waiting_event IS NOT NULL;
CREATE INDEX journey_participants_journey ON journey_participants (workspace_id, journey_id, profile_id);

ALTER TABLE journey_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journey_participants
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON journey_participants TO am_app;
GRANT USAGE ON SEQUENCE journey_participants_id_seq TO am_app;
