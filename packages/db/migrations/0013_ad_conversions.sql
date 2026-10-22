-- Wave 2, Phase 9: conversions sent to ad platforms go through the deliveries outbox, with
-- retries, rate limits and a per-person record (profile_id) for access requests and erasure.
ALTER TABLE deliveries DROP CONSTRAINT deliveries_kind_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_kind_check CHECK (kind IN ('webhook', 'action', 'ad_conversion'));
CREATE INDEX deliveries_profile ON deliveries (workspace_id, profile_id) WHERE profile_id IS NOT NULL;
