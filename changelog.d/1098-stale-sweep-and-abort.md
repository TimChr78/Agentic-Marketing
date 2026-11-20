---
section: Fixed
issues: [1098]
---
- A message the delivery worker left in `sending` is now marked `failed`/`unknown_outcome` with
  the same decision event the per-message recovery writes, in the same transaction, so reports and
  guardrails see it whichever writer recorded it.
- A send that finishes after the stale sweep already recorded `unknown_outcome` no longer
  overwrites that row with `sent` or returns it to `queued` (a possible duplicate send). The
  sweep's outcome stands and the drop is logged; the same guard applies to the SMS and push paths.
- On shutdown, the http drain now aborts the requests it force-closes. A copilot turn stops
  before its next model step (a provider call already sent finishes under its own deadline) and
  stores the turn and settles its AI reservation before the pools close; if that write cannot
  finish, it is skipped with a log line instead of failing against a closed pool.
