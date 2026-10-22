-- Wave 2, Phase 11: SCIM 2.0 provisioning. An identity provider (Okta, Entra ID, Google…) adds,
-- updates and deactivates a workspace's members through /scim/v2 with the workspace's SCIM token.
-- Groups map to roles; a person's role is the highest role of their mapped groups, or the default.
-- Owners are never changed by SCIM.
CREATE TABLE scim_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  default_role text NOT NULL DEFAULT 'viewer' CHECK (default_role IN ('admin', 'marketer', 'approver', 'viewer')),
  group_roles jsonb NOT NULL DEFAULT '{}',
  token_hash text UNIQUE,
  token_created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scim_users (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  external_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE scim_groups (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  display_name text NOT NULL,
  external_id text,
  members text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_settings', 'scim_users', 'scim_groups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_settings, scim_users, scim_groups TO am_app;
