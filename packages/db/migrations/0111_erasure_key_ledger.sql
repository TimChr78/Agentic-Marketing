-- The durable erasure-key ledger (#1037, 0.17.0 part 1).
--
-- One row per identifier an erasure covers: the whole merged profile family, the anonymous and
-- user ids that stored rows carry, and the keyed e-mail and phone hashes. Read-time exclusion (the
-- next part of #1037) matches ClickHouse subject keys against these rows. Unlike
-- `erasure_tombstones`, nothing prunes them after a grace window: an erased identifier stays
-- excluded permanently, and rows inserted afterwards are excluded too.
--
-- `key_value` is pseudonymous by construction. Profile, anonymous and user ids are the same values
-- the event store already holds, and an e-mail or phone value is the workspace matching key's HMAC,
-- never the address or number. `key_version` names the matching data key that produced a hash
-- (empty for values that are not hashed, such as profile ids), so a row stays interpretable after a
-- key rotation. `erasure_id` ties the row to its erasure for the restore replay and operations.
CREATE TABLE erasure_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('profile', 'anonymous_id', 'user_id', 'email', 'phone')),
  key_value text NOT NULL,
  key_version text NOT NULL DEFAULT '',
  erasure_id text NOT NULL,
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
  'Durable erasure-key ledger (#1037): one pseudonymous key per erased identifier, never pruned by the grace window.';
COMMENT ON COLUMN erasure_keys.kind IS
  'profile, anonymous_id, user_id, or the keyed e-mail (email) and phone (phone) hashes.';
COMMENT ON COLUMN erasure_keys.key_value IS
  'A profile, anonymous or user id (as stored in events), or the matching key HMAC for e-mail/phone.';
COMMENT ON COLUMN erasure_keys.key_version IS
  'The matching data key id that produced a hashed value; empty for values that are not hashed.';
COMMENT ON COLUMN erasure_keys.recorded_at IS
  'When the identifier was erased; refreshed when the same key is erased again. Never pruned by the grace window.';
