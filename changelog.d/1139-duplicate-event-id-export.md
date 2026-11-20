---
section: Fixed
issues: [1139]
---
- A duplicate `event_id` no longer wedges the PostgreSQL warehouse export: each batch is deduplicated by the dataset key before it is written, keeping the last row.
