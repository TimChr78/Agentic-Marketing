---
section: Fixed
issues: [1014]
---
- Server shutdown now attempts every close step even when an earlier one fails, logs each failure by step name (never the error text) and exits non-zero; a worker that fails while draining counts too, so a supervisor can tell a clean stop from a worker or pool that was left behind. A second SIGTERM/SIGINT during shutdown no longer starts a second shutdown: it exits immediately.
- The fake LLM server used by the AI tests answers malformed JSON with an error instead of leaving the request hanging, and the fake ad, secret, edge and rollout servers answer 500 when their handler throws, so a failing test fails instead of timing out.
