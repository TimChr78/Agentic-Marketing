---
section: Fixed
issues: [1219]
---
- An erasure cleanup job that failed after its exclusion was published is now re-opened when the scheduler starts, with a fresh retry budget, so the recovery `am doctor` and the operations guide describe actually happens: fix Valkey or ClickHouse, restart the scheduler, and the purge and hot-state cleanup finish. A job re-opened after a long outage also gets a whole budget instead of landing back in `failed` after one attempt.
