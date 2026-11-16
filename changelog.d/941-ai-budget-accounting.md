---
section: Fixed
issues: [941]
---
- The monthly AI token budget can no longer be exceeded by a settlement racing a budget check, a failed model call is charged what the provider billed (or its reserved estimate when no usage is known), prompt-test and journey holds last for the billing period instead of five minutes, and usage is counted in the month it was billed rather than the month it was queued. Migration 0097 adds `ai_calls.billed_at`, `usage_estimated` and `reservation_id`; existing rows fall back to `created_at`.
