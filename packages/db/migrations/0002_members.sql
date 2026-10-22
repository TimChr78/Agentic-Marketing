-- Members and invitations. Owners and admins invite people by e-mail; the invitee accepts with a
-- one-time link while signed in with that e-mail. Only a hash of the invitation token is stored.

CREATE TABLE invitations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'marketer', 'approver', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
-- At most one open invitation per address and workspace.
CREATE UNIQUE INDEX invitations_open ON invitations (workspace_id, lower(email)) WHERE status = 'pending';

-- workspace_members was read-only for the app until now; it gets row-level security like every
-- other tenant table now that the app can change memberships. Membership lookups at sign-in use
-- the admin connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations', 'workspace_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON invitations TO am_app;
GRANT INSERT, UPDATE, DELETE ON workspace_members TO am_app;
