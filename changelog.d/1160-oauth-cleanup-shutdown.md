---
section: Fixed
issues: [1160]
---
- Scheduler shutdown waits for an in-flight expired OAuth-consent cleanup instead of closing the database underneath it, and an already-aborted scheduler no longer starts one.
