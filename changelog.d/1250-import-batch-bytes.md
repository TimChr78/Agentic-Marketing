---
section: Fixed
issues: [1250]
---
- The Imports page sends a large CSV in batches sized by both row count and encoded bytes, so a Kit export of 5,000 rows no longer fails with the 1 MB request limit.
