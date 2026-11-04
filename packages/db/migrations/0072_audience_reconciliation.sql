-- Audience reconciliation redesign (#400, #401, #402). The member ledger now records the immutable
-- destination a person was uploaded to (connection plus operating account plus audience/list id),
-- durable remote-write intents cover an add/update that is confirmed or ambiguous but whose ledger
-- row is not written yet, and orphaned rows can be inspected/acknowledged by a person.
--
-- Upgrade notes:
--  * `destination_key` and `destination_known` have defaults for a rolling deploy. An old pod that
--    still inserts into audience_members writes `legacy:unknown` / unknown provenance, which is
--    surfaced as cleanup owed instead of failing the insert. The new code always sets both.
--  * Existing rows cannot prove where they were uploaded. They are kept as explicit legacy
--    obligations; this migration never guesses the current artifact destination.

ALTER TABLE audience_members
  ADD COLUMN destination_key text NOT NULL DEFAULT 'legacy:unknown',
  ADD COLUMN connection_id text,
  ADD COLUMN destination_id text,
  ADD COLUMN operating_account_id text,
  ADD COLUMN login_account_id text,
  ADD COLUMN destination_known boolean NOT NULL DEFAULT false,
  ADD COLUMN orphaned_at timestamptz,
  ADD COLUMN orphaned_reason text,
  ADD COLUMN cleanup_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Tenant tables FORCE row-level security, so the owner (the role running migrations) would
-- otherwise update no rows; lift FORCE for this backfill only.
ALTER TABLE audience_members NO FORCE ROW LEVEL SECURITY;
UPDATE audience_members
SET destination_key = 'legacy:unknown',
    destination_known = false,
    orphaned_at = now(),
    orphaned_reason = 'uploaded before 0.7.4: destination was not recorded';
ALTER TABLE audience_members FORCE ROW LEVEL SECURITY;

ALTER TABLE audience_members DROP CONSTRAINT audience_members_pkey;
ALTER TABLE audience_members
  ADD CONSTRAINT audience_members_pkey PRIMARY KEY (workspace_id, sync_id, platform, destination_key, profile_id);

CREATE INDEX audience_members_orphaned_idx
  ON audience_members (workspace_id, cleanup_id)
  WHERE orphaned_at IS NOT NULL;

CREATE TABLE audience_write_intents (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  sync_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('meta', 'google')),
  destination_key text NOT NULL,
  connection_id text NOT NULL,
  destination_id text NOT NULL,
  operating_account_id text NOT NULL,
  login_account_id text,
  profile_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('add')),
  hashes jsonb NOT NULL,
  orphaned_at timestamptz,
  orphaned_reason text,
  cleanup_id uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sync_id, platform, destination_key, profile_id, op)
);

CREATE INDEX audience_write_intents_orphaned_idx
  ON audience_write_intents (workspace_id, cleanup_id)
  WHERE orphaned_at IS NOT NULL;
CREATE INDEX audience_write_intents_sync_idx
  ON audience_write_intents (workspace_id, sync_id, platform, destination_key);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audience_write_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO am_app', t);
  END LOOP;
END $$;

ALTER TABLE audience_sync_state
  ADD COLUMN destination_key text,
  ADD COLUMN last_profile_id text,
  ADD COLUMN reconcile_profile_id text,
  ADD COLUMN unresolved integer NOT NULL DEFAULT 0;

-- Surface the legacy cleanup immediately, before the next scheduler/manual run. Both tenant
-- tables FORCE row-level security, so lift it for this backfill only (the subquery reads members).
ALTER TABLE audience_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audience_sync_state NO FORCE ROW LEVEL SECURITY;
UPDATE audience_sync_state s
SET unresolved = (
  SELECT count(*)::int FROM audience_members m
  WHERE m.workspace_id = s.workspace_id AND m.sync_id = s.sync_id AND m.platform = s.platform
    AND (NOT m.destination_known OR m.orphaned_at IS NOT NULL)
);
ALTER TABLE audience_sync_state FORCE ROW LEVEL SECURITY;
ALTER TABLE audience_members FORCE ROW LEVEL SECURITY;
