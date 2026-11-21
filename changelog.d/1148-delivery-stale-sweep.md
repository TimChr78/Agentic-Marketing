---
section: Fixed
issues: [1148]
---
- A delivery worker no longer sends a message that the stale sweep already settled as `unknown_outcome` while it waited in a batch, and no longer rewrites that outcome back to `queued` or `suppressed`. A message deleted by an erasure before delivery is skipped instead of crashing the worker.
