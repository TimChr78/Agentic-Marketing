---
section: Fixed
issues: [1250]
---
- The Imports page sends a large CSV in batches sized by both row count and encoded bytes, refuses a single oversized row up front with its CSV line number, and keeps the people already imported when a later batch fails.
