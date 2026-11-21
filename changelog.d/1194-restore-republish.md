---
section: Security
issues: [1194]
---
- A restore re-publishes an erasure's ClickHouse exclusions even when the Postgres snapshot already
  carried the cleanup job as complete. The replay clears the job's publication record and sweep
  checkpoints and queues it again, so `profiles.erasureStatus` reports pending instead of complete
  while the restored ClickHouse has lost its `erased_subjects` rows; the erased person is excluded
  again as soon as the job republishes. A completed job without a publication record now also
  reports pending, not complete.
