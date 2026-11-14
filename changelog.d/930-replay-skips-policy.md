---
section: Fixed
issues: [930]
---
- An idempotent retry of an agent write now returns the original response without running the policy engine, the daily counters or the billed independent check again. The retry is no longer refused when the first action filled a daily limit, and it is not charged a second model call.
- Authentication, permissions, input validation and the agent's current status still run before a replay: a paused or revoked agent gets the same refusal as any other request, and a key reused for a different request still answers 409 before policy runs.
- A replayed agent write still leaves one ledger row and one audit row, as before.
