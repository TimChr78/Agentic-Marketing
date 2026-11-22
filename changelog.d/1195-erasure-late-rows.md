---
section: Security
issues: [1195]
---
- Message counts and message statistics now exclude an erased person inside the counting query itself, so a message committed while the count is running cannot slip through. A row written by an old-style writer after an erasure completed is treated as unverified and is no longer returned until the subject-key backfill covers it.
