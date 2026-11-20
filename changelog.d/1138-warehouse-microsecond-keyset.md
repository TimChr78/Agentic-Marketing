---
section: Fixed
issues: [1138]
---
- Warehouse exports no longer repeat rows that share a millisecond and no longer loop forever when a whole page of profiles or identifiers changed in the same transaction. The export cursor now keeps PostgreSQL's microseconds.
