-- Profiles, identity and consent (data-platform.md §3–4, security-and-privacy.md §2–3).
--
-- Personal data is encrypted per person: each profile has its own key (profile_keys), wrapped by
-- the workspace's data key. Erasure deletes that key, which makes every copy of the data that
-- remains, in backups too, unreadable. E-mail addresses and phone numbers are matched by HMAC,
-- never by plaintext.

-- Data keys get a purpose: 'secrets' (provider keys…), 'identity' (wraps profile keys) and
-- 'matching' (HMAC key for identifiers). One active key per purpose.
ALTER TABLE data_keys ADD COLUMN purpose text NOT NULL DEFAULT 'secrets' CHECK (purpose IN ('secrets', 'identity', 'matching'));
DROP INDEX data_keys_one_active;
CREATE UNIQUE INDEX data_keys_one_active ON data_keys (workspace_id, purpose) WHERE active;

CREATE TABLE profiles (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  merged_into text,
  traits jsonb NOT NULL DEFAULT '{}',
  pii bytea,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX profiles_recent ON profiles (workspace_id, last_seen DESC) WHERE merged_into IS NULL;

CREATE TABLE profile_keys (
  workspace_id uuid NOT NULL,
  profile_id text NOT NULL,
  data_key_id text NOT NULL,
  wrapped_key bytea NOT NULL,
  PRIMARY KEY (workspace_id, profile_id),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, data_key_id) REFERENCES data_keys (workspace_id, id)
);

-- value: the id itself for anonymous_id / user_id (they are pseudonymous and needed to find
-- events), an HMAC for email / phone. value_enc: the e-mail or phone number, sealed with the
-- profile key, for display and sending.
CREATE TABLE identifiers (
  workspace_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('anonymous_id', 'user_id', 'email', 'phone')),
  value text NOT NULL,
  profile_id text NOT NULL,
  value_enc bytea,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, type, value),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX identifiers_profile ON identifiers (workspace_id, profile_id);

CREATE TABLE profile_merges (
  workspace_id uuid NOT NULL,
  from_id text NOT NULL,
  into_id text NOT NULL,
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, from_id)
);
CREATE INDEX profile_merges_into ON profile_merges (workspace_id, into_id);

-- Append-only consent and objection ledger. Records keep the profile they were made on; after a
-- merge the survivor's state is computed over its own and its merged profiles' records.
CREATE TABLE consent_records (
  workspace_id uuid NOT NULL,
  id bigserial,
  profile_id text NOT NULL,
  purpose text NOT NULL,
  channel text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('granted', 'denied', 'withdrawn', 'objected')),
  basis text NOT NULL,
  source text NOT NULL CHECK (source IN ('sdk', 'form', 'import', 'api', 'unsubscribe', 'agent')),
  proof jsonb NOT NULL DEFAULT '{}',
  message_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX consent_records_profile ON consent_records (workspace_id, profile_id, recorded_at);
-- A re-delivered consent event records nothing new.
CREATE UNIQUE INDEX consent_records_message ON consent_records (workspace_id, message_id, purpose, channel) WHERE message_id IS NOT NULL;

CREATE TABLE consent_state (
  workspace_id uuid NOT NULL,
  profile_id text NOT NULL,
  purpose text NOT NULL,
  channel text NOT NULL DEFAULT '',
  status text NOT NULL,
  basis text NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, purpose, channel),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);

-- Hashes that must never be contacted again, e.g. after an erasure. Survive the erasure itself.
CREATE TABLE suppressions (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel text NOT NULL,
  value_hash text NOT NULL,
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel, value_hash)
);

-- Proof that an erasure happened, without the personal data it removed.
CREATE TABLE erasures (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  profile_ids text[] NOT NULL,
  requested_by text NOT NULL,
  reason text NOT NULL,
  counts jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'profile_keys', 'identifiers', 'profile_merges', 'consent_records', 'consent_state', 'suppressions', 'erasures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, profile_keys, identifiers, consent_state TO am_app;
GRANT SELECT, INSERT ON profile_merges, suppressions, erasures TO am_app;
-- The ledger is append-only for the app, except that erasure removes a person's records.
GRANT SELECT, INSERT, DELETE ON consent_records TO am_app;
GRANT USAGE ON SEQUENCE consent_records_id_seq TO am_app;
GRANT DELETE ON profile_merges TO am_app;
