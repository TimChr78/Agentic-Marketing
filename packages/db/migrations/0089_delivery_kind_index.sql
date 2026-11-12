-- am:no-transaction
-- deliveries.list now filters by kind (#615). The webhooks card reads only webhook deliveries,
-- newest first; without a kind column the workspace's whole delivery log is scanned and sorted, so
-- busy action or ad-conversion traffic hides webhook rows behind the limit. The existing
-- deliveries_recent (workspace_id, target_id, created_at) cannot serve a kind-only read: target_id
-- splits the order. Built CONCURRENTLY so delivery writes keep flowing (#453, 0.10.1 review).
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_kind_recent
  ON deliveries (workspace_id, kind, created_at DESC);
