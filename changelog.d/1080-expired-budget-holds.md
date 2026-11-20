---
section: Fixed
issues: [1080]
---
- The scheduler removes expired live AI budget holds that no `ai_calls` row links to, after their
  own deadline plus a grace window. A crash during a decision, copilot, hosted or independent-check
  call no longer leaves dead rows in `ai_token_reservations` for ever. A hold that still guards
  billed usage is never deleted: linked holds stay with the crash-recovery path, and an expired hold
  no longer counts against the monthly budget.
