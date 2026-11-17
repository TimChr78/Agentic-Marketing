---
section: Fixed
issues: [1014]
---
- Server shutdown now attempts every close step even when an earlier one fails, logs each failure and exits non-zero, so a supervisor can tell a clean stop from a worker or pool that was left behind. A second SIGTERM/SIGINT during shutdown no longer starts a second shutdown: it exits immediately.
- The fake LLM server used by the AI tests answers malformed JSON with an error instead of leaving the request hanging, and the fake ad, secret, edge and rollout servers answer 500 when their handler throws, so a failing test fails instead of timing out.
