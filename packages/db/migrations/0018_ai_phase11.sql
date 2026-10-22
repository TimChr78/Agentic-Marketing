-- Wave 2, Phase 11: AI.
-- * ai.classify calls are logged like the others (kind "classify").
-- * Answers can be sampled for a person to review: review_status 'pending' until someone gives a verdict.
-- * Generated text can be cached per combination of segments (ai_text_cache), written from the
--   segment names alone, so the same text serves everyone in them without personal data.
-- * Copilot conversations are kept on the server, per person: each turn stores the model
--   messages (to continue the conversation) and the events the person saw (to show it again).
ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_kind_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_kind_check CHECK (kind IN ('decide', 'generate', 'copilot', 'test', 'classify'));
ALTER TABLE ai_calls
  ADD COLUMN cached boolean NOT NULL DEFAULT false,
  ADD COLUMN review_status text CHECK (review_status IN ('pending', 'reviewed')),
  ADD COLUMN review_verdict text CHECK (review_verdict IN ('good', 'bad')),
  ADD COLUMN review_note text,
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz;
CREATE INDEX ai_calls_review ON ai_calls (workspace_id, created_at) WHERE review_status = 'pending';

CREATE TABLE ai_text_cache (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  prompt_id text NOT NULL,
  prompt_version integer NOT NULL,
  cache_key text NOT NULL,
  slots jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, prompt_id, prompt_version, cache_key)
);

CREATE TABLE copilot_conversations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX copilot_conversations_user ON copilot_conversations (workspace_id, user_id, updated_at DESC);

CREATE TABLE copilot_turns (
  workspace_id uuid NOT NULL,
  conversation_id text NOT NULL,
  n integer NOT NULL,
  messages jsonb NOT NULL,
  events jsonb NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id, n),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES copilot_conversations (workspace_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_text_cache', 'copilot_conversations', 'copilot_turns'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_text_cache, copilot_conversations, copilot_turns TO am_app;
