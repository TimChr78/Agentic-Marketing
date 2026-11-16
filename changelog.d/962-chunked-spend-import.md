---
section: Fixed
issues: [962]
---
- A large Google Ads spend import is stored page by page in bounded chunks instead of being read into memory twice and written in one ClickHouse call, so a 90-day read at the raised page ceiling no longer risks an out-of-memory kill on the API process. The incomplete date range is recorded before the first insert, so a crash or OOM mid-import leaves the `spendTruncated` warning in place instead of losing it with the insert; chunks of one import share an `updated_at`, so a re-import still replaces the previous rows rather than double counting.
