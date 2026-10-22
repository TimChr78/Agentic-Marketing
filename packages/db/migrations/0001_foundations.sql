-- Phase 0 foundations: tenancy, versioned artifacts with approvals, audit log, idempotency, secrets.
-- Every tenant table carries workspace_id and is protected by row-level security. The application
-- connects as am_app (no BYPASSRLS) and sets app.workspace_id per transaction.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  approval_policy text NOT NULL DEFAULT 'agent_changes'
    CHECK (approval_policy IN ('none', 'agent_changes', 'all_publishes')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'marketer', 'approver', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  latest_version integer NOT NULL,
  published_version integer,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX artifacts_type ON artifacts (workspace_id, type, updated_at DESC);

CREATE TABLE artifact_versions (
  workspace_id uuid NOT NULL,
  artifact_id text NOT NULL,
  number integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'in_review', 'published', 'superseded', 'rejected')),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  based_on integer,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text NOT NULL,
  author_client text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id, number),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE approval_requests (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  artifact_id text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by_type text NOT NULL,
  requested_by_id text NOT NULL,
  requested_by_client text,
  note text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id, version) REFERENCES artifact_versions (workspace_id, artifact_id, number) ON DELETE CASCADE
);
CREATE INDEX approval_requests_pending ON approval_requests (workspace_id, created_at) WHERE status = 'pending';

CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  client_id text,
  surface text NOT NULL,
  command text NOT NULL,
  effect text NOT NULL,
  target text,
  input_hash text NOT NULL,
  ok boolean NOT NULL,
  error text,
  prev_hash text,
  hash text NOT NULL
);
CREATE INDEX audit_log_workspace ON audit_log (workspace_id, seq DESC);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  command text NOT NULL,
  input_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- Envelope encryption: each workspace has data keys wrapped by a key-encryption key (KEK) that
-- never touches the database. Secrets are encrypted with the active data key.
CREATE TABLE data_keys (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  kek_id text NOT NULL,
  wrapped_key bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX data_keys_one_active ON data_keys (workspace_id) WHERE active;

CREATE TABLE secrets (
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  data_key_id text NOT NULL,
  iv bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id, data_key_id) REFERENCES data_keys (workspace_id, id)
);

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['artifacts', 'artifact_versions', 'approval_requests', 'audit_log', 'idempotency_keys', 'data_keys', 'secrets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Privileges of the application role. The audit log is append-only for the app.
GRANT SELECT, UPDATE ON workspaces TO am_app;
GRANT SELECT ON workspace_members TO am_app;
GRANT SELECT, INSERT, UPDATE ON artifacts, artifact_versions, approval_requests, idempotency_keys, data_keys TO am_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON secrets TO am_app;
GRANT SELECT, INSERT ON audit_log TO am_app;
GRANT USAGE ON SEQUENCE audit_log_seq_seq TO am_app;
