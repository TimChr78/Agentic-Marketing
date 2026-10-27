-- 0.2.8 (issues #92, #93): wait-until participants need an absolute timeout beside the next
-- check, and entry keys need "one active participant per key" so after_exit can re-enter.
ALTER TABLE journey_participants ADD COLUMN IF NOT EXISTS waiting_until timestamptz;

-- The old rule made a key unique forever, which is right for re-entry "once" but blocks
-- "after_exit". Uniqueness now applies to the participants who are still in the journey; the
-- runtime checks exited participants for "once".
ALTER TABLE journey_participants DROP CONSTRAINT IF EXISTS journey_participants_workspace_id_journey_id_entry_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS journey_participants_active_entry_key
  ON journey_participants (workspace_id, journey_id, entry_key)
  WHERE status IN ('ready', 'waiting');

-- Suppressed event entries (#93), counted per journey for journeys.stats.
CREATE TABLE journey_entry_skips (
  workspace_id uuid NOT NULL,
  journey_id text NOT NULL,
  duplicates_skipped integer NOT NULL DEFAULT 0,
  missing_key_skipped integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, journey_id)
);

ALTER TABLE journey_entry_skips ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_entry_skips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journey_entry_skips
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON journey_entry_skips TO am_app;
