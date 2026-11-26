---
section: Fixed
issues: [1243]
---
- `ai.calls` paging uses a full-precision cursor with an id tie-breaker, so a page boundary inside a group of rows written at the same instant no longer drops the rest of the group. The existing `before` input is still accepted.
