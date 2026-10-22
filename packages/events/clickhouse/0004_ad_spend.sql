-- Ad spend per platform, account, campaign and day (Phase 9), imported from Meta Insights and
-- Google Ads reports. Re-imports of a day replace it (latest updated_at wins).
CREATE TABLE IF NOT EXISTS ad_spend (
  workspace_id UUID,
  platform LowCardinality(String),
  account String,
  campaign_id String,
  campaign_name String,
  date Date,
  cost Float64,
  currency LowCardinality(String),
  impressions UInt64,
  clicks UInt64,
  platform_conversions Float64,
  updated_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(date)
ORDER BY (workspace_id, platform, account, campaign_id, date)
TTL date + INTERVAL 25 MONTH
