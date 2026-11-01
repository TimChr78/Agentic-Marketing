-- Phase 21 (#194, epic #192): decision models through TypeSafe's System One API (JEV).
--
-- A decision provider is a third AI provider kind: it returns typed probabilities and scores,
-- never text. `allow_personal_data` is false by default and settable only by a person, because
-- the upstream JEV API has no zero-data-retention path for our deployments. `score` is the
-- ai_calls kind for calibrated decision calls, and profile_scores keeps a named score for a
-- person so segments and journeys can read it (expires_at is the TTL).
ALTER TABLE ai_providers DROP CONSTRAINT ai_providers_kind_check;
ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_kind_check
  CHECK (kind IN ('openai-compatible', 'anthropic-compatible', 'decision'));
ALTER TABLE ai_providers ADD COLUMN allow_personal_data boolean NOT NULL DEFAULT false;

ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_kind_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_kind_check
  CHECK (kind IN ('decide', 'generate', 'copilot', 'test', 'classify', 'check', 'hosted', 'score'));

CREATE TABLE profile_scores (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  key text NOT NULL,
  value double precision NOT NULL,
  confidence double precision,
  probabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL,
  model_version text NOT NULL,
  call_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, key),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX profile_scores_key ON profile_scores (workspace_id, key, created_at DESC);
CREATE INDEX profile_scores_expiry ON profile_scores (workspace_id, expires_at);

ALTER TABLE profile_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profile_scores
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_scores TO am_app;
