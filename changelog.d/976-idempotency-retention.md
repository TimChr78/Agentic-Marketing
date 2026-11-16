---
section: Changed
issues: [976]
---
- Idempotency keys are kept for 30 days (`RETENTION_IDEMPOTENCY_DAYS`). A key reused after that runs the operation again and stores a fresh row, and the scheduler removes expired rows in small batches so `idempotency_keys` no longer grows without limit.
