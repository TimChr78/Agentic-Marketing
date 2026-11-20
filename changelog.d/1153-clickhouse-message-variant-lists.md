---
section: Fixed
issues: [1153]
---
- Large subject tests can decide their winner again: per-variant results are aggregated in ClickHouse by broadcast instead of sending every message id, and `messages.stats` filters the variant there too. It also accepts a broadcast `bct_` id as `journeyId`.
