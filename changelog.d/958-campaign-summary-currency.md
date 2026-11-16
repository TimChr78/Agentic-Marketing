---
section: Fixed
issues: [958]
---
- `analytics.campaignSummary` no longer publishes `meta.currency` for a single suppressed currency or for `UNKNOWN`. It names a currency only when there is exactly one revenue row, its amount is visible and the currency is known, which is the same rule `analytics.query` applies; a client keying suppression detection on `meta.currency === null` no longer misses a withheld revenue figure.
