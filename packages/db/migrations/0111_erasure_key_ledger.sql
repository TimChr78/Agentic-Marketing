-- The durable erasure-key ledger (#1037, 0.17.0 part 1) and the exclusion key.
--
-- One row per identifier an erasure covers. Read-time exclusion (the next part of #1037) matches
-- ClickHouse subject keys against these rows. Unlike `erasure_tombstones`, nothing prunes them
-- after a grace window: an erased identifier stays excluded permanently, and rows inserted
-- afterwards are excluded too.
--
-- Every `key_value` is HMAC_exclusion(kind, normalised value): a separate, workspace-scoped
-- exclusion key that is never sent to ClickHouse, never the matching key, and not rotated with it.
-- Profile, anonymous and user ids, alias previous ids, click ids, e-mail and phone are therefore
-- all stored as keyed hashes — there is no raw identifier in this table. `key_version` names the
-- exclusion data key that produced the hash, so both versions are interpretable during a planned
-- re-key. `erasure_id` ties the row to its erasure for the restore replay and operations.

-- The exclusion key is its own purpose, separate from the matching HMAC key. Re-wrapping it with
-- the KEK (`am rotate-keys`) is not a re-key and does not change its id or its hashes.
ALTER TABLE data_keys DROP CONSTRAINT IF EXISTS data_keys_purpose_check;
ALTER TABLE data_keys ADD CONSTRAINT data_keys_purpose_check
  CHECK (purpose IN ('secrets', 'identity', 'matching', 'exclusion'));

CREATE TABLE erasure_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'profile', 'anonymous_id', 'user_id', 'alias_previous_id', 'email', 'phone',
    'gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid', 'li_fat_id', 'ttclid', 'ttp', 'epik'
  )),
  key_value text NOT NULL,
  key_version text NOT NULL,
  erasure_id text NOT NULL,
  -- `full` is HMAC_exclusion of the value. `unavailable` marks an identifier whose plaintext
  -- cannot be recovered any more (e.g. a legacy e-mail identifier with no sealed value): the row
  -- keeps its matching hash, never a raw value, and PR 3 must refuse activation or exclude
  -- conservatively rather than pretend it matches.
  coverage text NOT NULL DEFAULT 'full' CHECK (coverage IN ('full', 'unavailable')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, key_value, key_version)
);

-- Restore replay and operations ask which keys one erasure recorded; exclusion asks for the
-- workspace's whole set through the primary key.
CREATE INDEX erasure_keys_erasure ON erasure_keys (workspace_id, erasure_id);

ALTER TABLE erasure_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON erasure_keys;
CREATE POLICY tenant_isolation ON erasure_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- UPDATE is needed for the upsert when an identifier is erased again; rows are only ever changed
-- by that ON CONFLICT clause. A restore replay inserts with ON CONFLICT DO NOTHING.
GRANT SELECT, INSERT, UPDATE ON erasure_keys TO am_app;

COMMENT ON TABLE erasure_keys IS
  'Durable erasure-key ledger (#1037): HMAC_exclusion of every erased identifier, never pruned by the grace window.';
COMMENT ON COLUMN erasure_keys.kind IS
  'profile, anonymous_id, user_id, alias_previous_id, email, phone, or a supported ad click id.';
COMMENT ON COLUMN erasure_keys.key_value IS
  'HMAC_exclusion(kind, normalised value) under the workspace exclusion key; never a raw identifier.';
COMMENT ON COLUMN erasure_keys.key_version IS
  'The exclusion data key id that produced key_value; entries stay valid while that key is retained.';
COMMENT ON COLUMN erasure_keys.coverage IS
  'full, or unavailable when the identifier plaintext could not be recovered; unavailable rows must not be matched.';
COMMENT ON COLUMN erasure_keys.recorded_at IS
  'When the identifier was erased; refreshed when the same key is erased again. Never pruned by the grace window.';
