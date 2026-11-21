---
section: Fixed
issues: [1140]
---
- The subject-key backfill retries a transient ClickHouse or PostgreSQL error with backoff instead of stopping for the lifetime of the process, so erasure cleanups no longer stay blocked after a brief outage. A genuinely missing table or column still stops the pass until the next start.
