---
section: Fixed
issues: [1226]
---
- The subject-key backfill now reads only the granules after its cursor instead of the workspace's whole event table for every batch, so the one-off pass after upgrading no longer turns into a sustained full-table read on a large history.
