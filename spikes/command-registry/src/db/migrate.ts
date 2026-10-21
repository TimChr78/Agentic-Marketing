import { getMigrations } from 'better-auth/db/migration';
import { adminPool } from './pool';
import { authOptions } from '../auth';

const tenantTables = ['artifacts', 'artifact_versions', 'audit_log', 'idempotency_keys'];

const sql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'am_app') THEN
    CREATE ROLE am_app LOGIN PASSWORD 'am_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  approval_policy text NOT NULL DEFAULT 'agent_changes'
    CHECK (approval_policy IN ('none', 'agent_changes', 'all_publishes'))
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'marketer', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  published_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS artifact_versions (
  workspace_id uuid NOT NULL,
  artifact_id text NOT NULL,
  number integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'in_review', 'published', 'superseded')),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  author_type text NOT NULL,
  author_id text NOT NULL,
  author_client text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id, number),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  client_id text,
  surface text NOT NULL,
  command text NOT NULL,
  effect text NOT NULL,
  input_hash text NOT NULL,
  ok boolean NOT NULL,
  error text,
  prev_hash text,
  hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  command text NOT NULL,
  input_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

GRANT SELECT ON workspaces, workspace_members TO am_app;
GRANT SELECT, INSERT, UPDATE ON artifacts, artifact_versions, idempotency_keys TO am_app;
GRANT SELECT, INSERT ON audit_log TO am_app;  -- append-only for the app role
GRANT USAGE ON SEQUENCE audit_log_seq_seq TO am_app;
`;

function rlsSql(table: string) {
  return `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);`;
}

export async function migrate() {
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  await adminPool.query(sql + tenantTables.map(rlsSql).join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log('migrated');
  await adminPool.end();
}
