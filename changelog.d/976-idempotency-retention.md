---
section: Changed
issues: [976]
---
- **Breaking:** idempotency keys are kept for 30 days (`RETENTION_IDEMPOTENCY_DAYS`) instead of indefinitely. A key reused after that runs the operation again and stores a fresh row; the scheduler removes expired rows in small batches so `idempotency_keys` no longer grows without limit.
