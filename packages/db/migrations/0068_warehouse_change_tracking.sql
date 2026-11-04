-- Warehouse change tracking (#374) and erasure keys (#373).
--
-- Incremental exports used business timestamps that some writers never touch: a merge re-points
-- identifiers.profile_id without changing first_seen, and recomputeConsentState materialises
-- consent_state.updated_at from the winning ledger record, which is often older than the export
-- cursor. Both changes were therefore never re-exported.
--
-- The columns below are markers of their own, maintained by triggers, so merges and consent
-- rewrites are picked up while identifiers.first_seen and consent_state.updated_at keep their
-- audit meaning. Existing rows start at the migration time, so the first export after an upgrade
-- re-sends identifiers and consent once: upserts make that harmless and it repairs a merge that
-- happened before the upgrade.
ALTER TABLE identifiers ADD COLUMN warehouse_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE consent_state ADD COLUMN warehouse_changed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX identifiers_warehouse_changed ON identifiers (workspace_id, warehouse_changed_at, type, value);
CREATE INDEX consent_state_warehouse_changed ON consent_state (workspace_id, warehouse_changed_at, profile_id, purpose, channel);

CREATE FUNCTION warehouse_identifier_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.warehouse_changed_at := now();
  RETURN NEW;
END $$;

-- last_seen is touched on every event; only a new row or a re-pointed identity has to be exported.
CREATE TRIGGER identifiers_warehouse_changed_insert
  BEFORE INSERT ON identifiers
  FOR EACH ROW EXECUTE FUNCTION warehouse_identifier_changed();
CREATE TRIGGER identifiers_warehouse_changed_update
  BEFORE UPDATE ON identifiers
  FOR EACH ROW WHEN (OLD.profile_id IS DISTINCT FROM NEW.profile_id)
  EXECUTE FUNCTION warehouse_identifier_changed();

-- consent_state is deleted and re-inserted by recomputeConsentState, so INSERT covers a rewrite;
-- UPDATE covers any direct correction by the app.
CREATE TRIGGER consent_state_warehouse_changed
  BEFORE INSERT OR UPDATE ON consent_state
  FOR EACH ROW EXECUTE FUNCTION warehouse_identifier_changed();

-- Erasure keys (#373): the pseudonymous user and anonymous ids of a person are deleted with the
-- profile, but a warehouse destination that does not export the identifiers dataset still needs
-- them to find that person's events. A trigger keeps them, in the same transaction as the erasure,
-- until every enabled destination has propagated the erasure. E-mail and phone hashes are never
-- captured: events only carry user and anonymous ids.
CREATE TABLE warehouse_erasure_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  type text NOT NULL,
  value text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, profile_id, type, value)
);
CREATE INDEX warehouse_erasure_keys_profile ON warehouse_erasure_keys (workspace_id, profile_id);

ALTER TABLE warehouse_erasure_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_erasure_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_erasure_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE FUNCTION warehouse_capture_erasure_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type IN ('user_id', 'anonymous_id') AND EXISTS (
    SELECT 1 FROM warehouse_exports WHERE workspace_id = OLD.workspace_id
  ) THEN
    INSERT INTO warehouse_erasure_keys (workspace_id, profile_id, type, value, at)
    VALUES (OLD.workspace_id, OLD.profile_id, OLD.type, OLD.value, now())
    ON CONFLICT (workspace_id, profile_id, type, value) DO UPDATE SET at = now();
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER identifiers_warehouse_erasure
  AFTER DELETE ON identifiers
  FOR EACH ROW EXECUTE FUNCTION warehouse_capture_erasure_key();

-- How many keys an erasure captured. Zero after key tracking began means the person had no user
-- or anonymous id at all, so no event can name them; a positive count with no keys left means the
-- keys were already pruned before this destination saw the erasure.
ALTER TABLE erasures ADD COLUMN warehouse_key_count integer NOT NULL DEFAULT 0;

CREATE FUNCTION warehouse_erasure_captured() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE erasures SET warehouse_key_count = (
    SELECT count(*) FROM warehouse_erasure_keys k
    WHERE k.workspace_id = NEW.workspace_id AND k.profile_id = ANY(NEW.profile_ids)
  ) WHERE workspace_id = NEW.workspace_id AND id = NEW.id;
  RETURN NEW;
END $$;

CREATE TRIGGER erasures_warehouse_captured
  AFTER INSERT ON erasures
  FOR EACH ROW EXECUTE FUNCTION warehouse_erasure_captured();
GRANT UPDATE (warehouse_key_count) ON erasures TO am_app;

-- Erasures recorded before this migration have no captured keys. The export uses this marker to
-- report such an erasure as not fully applied instead of claiming success for a silent no-op.
CREATE TABLE warehouse_erasure_key_tracking (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  since timestamptz NOT NULL DEFAULT now()
);
INSERT INTO warehouse_erasure_key_tracking DEFAULT VALUES;

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_erasure_keys TO am_app;
GRANT SELECT ON warehouse_erasure_key_tracking TO am_app;

-- With no warehouse destination there is no downstream erasure to service: do not retain raw
-- erased identifiers. Removing the final destination abandons that work and drops its keys.
CREATE FUNCTION warehouse_drop_unused_erasure_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM warehouse_exports WHERE workspace_id = OLD.workspace_id) THEN
    DELETE FROM warehouse_erasure_keys WHERE workspace_id = OLD.workspace_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER warehouse_exports_drop_unused_erasure_keys
  AFTER DELETE ON warehouse_exports
  FOR EACH ROW EXECUTE FUNCTION warehouse_drop_unused_erasure_keys();
