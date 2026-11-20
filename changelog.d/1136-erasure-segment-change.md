---
section: Security
issues: [1136]
---
- Erasure now waits for queued segment-membership events about the erased person before it completes, and it no longer deletes unrelated failed or delivered `segment_change` outbox batches in the workspace.
