-- Spend import completeness, kept with the spend it describes (#917 review rounds 2-3).
--
-- A truncated provider read stores the date range it could not complete. The state belongs to the
-- stored spend, not to the connection: renaming a connection, pointing it at another ad account or
-- deleting it must not clear a gap while that account's partial spend rows still feed reports.
-- `ad_spend` rows carry (workspace, platform, account), so gaps are keyed by the same identity.
--
-- The import reads and rewrites one key's ranges under a transaction-scoped advisory lock, so two
-- concurrent imports for one account cannot overwrite each other's result.
CREATE TABLE IF NOT EXISTS ad_spend_gaps (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  platform text NOT NULL,
  account text NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, account, from_date)
);

ALTER TABLE ad_spend_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend_gaps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ad_spend_gaps;
CREATE POLICY tenant_isolation ON ad_spend_gaps
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ad_spend_gaps TO am_app;

COMMENT ON TABLE ad_spend_gaps IS
  'Date ranges a spend import could not fetch completely, per workspace, platform and ad account (#917).';
