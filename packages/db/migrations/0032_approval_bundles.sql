-- 0.2.6 (issue #107): approval bundles. Artifacts that depend on each other (a broadcast and the
-- template it sends, a form and its confirmation template) are reviewed as one request: one row per
-- artifact, sharing a bundle id, approved or rejected together and published in dependency order
-- in one transaction. Requests without a bundle work as before.
ALTER TABLE approval_requests ADD COLUMN bundle_id text;
CREATE INDEX approval_requests_bundle ON approval_requests (workspace_id, bundle_id) WHERE bundle_id IS NOT NULL;
