-- Wave 2, Phase 9 part 2: segments synced to ad platform audiences (Meta custom audiences,
-- Google Customer Match). What was added is kept per sync, platform and person, with the hashes
-- that were sent, so people who leave the segment, withdraw ad_targeting or are erased can be
-- removed again. Deliberately no foreign key to profiles: an erased person's row must outlive the
-- profile until the removal has been sent, then it is deleted.
CREATE TABLE audience_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  sync_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('meta', 'google')),
  profile_id text NOT NULL,
  hashes jsonb NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sync_id, platform, profile_id)
);

CREATE TABLE audience_sync_state (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  sync_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('meta', 'google')),
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error text,
  members integer NOT NULL DEFAULT 0,
  added integer NOT NULL DEFAULT 0,
  removed integer NOT NULL DEFAULT 0,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sync_id, platform)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audience_members', 'audience_sync_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO am_app', t);
  END LOOP;
END $$;
