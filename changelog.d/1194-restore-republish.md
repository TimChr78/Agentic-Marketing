---
section: Security
issues: [1194]
---
- `am restore` now reconciles the restored erasure ledger with ClickHouse's `erased_subjects`
  itself, as its last step after every ClickHouse load: missing exclusion keys are re-inserted in
  batches and confirmed visible before the restore reports success, and only then are the cleanup
  jobs marked published. This covers a Postgres-only restore, an older `--clickhouse` file, both,
  and a fresh target whose dump already carried a completed job, so an erased person is no longer
  readable after a restore, even before any scheduler runs. Completed jobs are
  published in bulk instead of being reopened for a fresh sweep; an unfinished job is queued for
  its remaining sweep. If a restore stops before reconciliation, it leaves a marker that makes the
  server refuse to serve reads until a restore completes, and a restore refuses to run while an app
  process is connected. A completed job from before the publication record (or the durable ledger)
  keeps its legacy status instead of reporting `pending` forever, and `profiles.erasureStatus`
  reports such a legacy erasure with `exclusion: 'unknown'` and `reason: 'legacy'`.
