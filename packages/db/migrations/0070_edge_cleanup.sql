-- Edge mirroring cleanup (#403, #404). Turning serving off now owes a remote deletion instead of
-- silently leaving the bundle, write keys and people's snapshots in Workers KV, and moving to
-- another account/namespace records the destination left behind so its copies can be removed.
ALTER TABLE edge_targets
  ADD COLUMN cleanup_mode text,
  ADD COLUMN prior_target jsonb;

ALTER TABLE edge_targets
  ADD CONSTRAINT edge_targets_cleanup_mode_check CHECK (cleanup_mode IS NULL OR cleanup_mode IN ('snapshots', 'all'));

-- Upgrade path for targets that were already disabled (or had snapshots off) under 0.7.1: their
-- remote copies were never removed, and only the sync can list and delete them. `all` also removes
-- the bundle and write keys, which is what turning the mirror off has to revoke. Tenant tables
-- FORCE row-level security, so the owner (the role running migrations) would otherwise update no
-- rows; lift FORCE for this backfill only.
ALTER TABLE edge_targets NO FORCE ROW LEVEL SECURITY;
UPDATE edge_targets SET cleanup_mode = 'all' WHERE NOT enabled;
UPDATE edge_targets SET cleanup_mode = 'snapshots' WHERE enabled AND NOT snapshots;
ALTER TABLE edge_targets FORCE ROW LEVEL SECURITY;
