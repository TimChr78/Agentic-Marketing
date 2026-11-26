---
section: Fixed
issues: [1240]
---
- A transient event-store failure during a journey sweep no longer fails the participant on the first error: the step is retried with a short backoff and the participant is failed only when its retry budget is spent. A broken condition still fails at once.
