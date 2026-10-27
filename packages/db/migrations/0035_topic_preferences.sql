-- 0.2.8 (#84): topics under purposes, their per-person choices, and the topic a message was sent
-- under. A topic is a finer choice within a purpose; consent for the purpose remains the only
-- lawful-basis gate, so these rows never rewrite consent_records or consent_state.

ALTER TABLE messages ADD COLUMN topic text;

-- The current choice per person and topic. The topic's default applies when there is no row.
CREATE TABLE topic_preferences (
  workspace_id uuid NOT NULL,
  profile_id text NOT NULL,
  topic text NOT NULL,
  status text NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  source text NOT NULL CHECK (source IN ('preference_center', 'unsubscribe_link', 'api', 'agent', 'import', 'form', 'sdk')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, profile_id, topic),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX topic_preferences_topic ON topic_preferences (workspace_id, topic, status);

-- Append-only evidence, like the consent ledger. Erasure removes it with the profile (cascade).
CREATE TABLE topic_preference_history (
  workspace_id uuid NOT NULL,
  id bigserial,
  profile_id text NOT NULL,
  topic text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  source text NOT NULL CHECK (source IN ('preference_center', 'unsubscribe_link', 'api', 'agent', 'import', 'form', 'sdk')),
  note text,
  proof jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX topic_preference_history_profile ON topic_preference_history (workspace_id, profile_id, recorded_at);

ALTER TABLE topic_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON topic_preferences
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE topic_preference_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_preference_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON topic_preference_history
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- No DELETE for the app: choices are overwritten, never removed one by one. Erasure removes them
-- through the profile cascade, which runs as the table owner.
GRANT SELECT, INSERT, UPDATE ON topic_preferences TO am_app;
GRANT SELECT, INSERT ON topic_preference_history TO am_app;
GRANT USAGE ON SEQUENCE topic_preference_history_id_seq TO am_app;
