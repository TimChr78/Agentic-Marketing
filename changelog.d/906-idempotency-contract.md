---
section: Changed
issues: [906]
---
- The idempotency contract is now documented and implemented by the shipped clients. `docs/integrations.md`, the architecture overview and the generated OpenAPI route descriptions explain that a key is remembered for the life of the workspace, that reusing it for another command or input answers `409` with `details.reason: "idempotency_key_reused"`, and that a `409` with `"idempotency_in_progress"` means the first request is still running: retry with the same key, never a new one.
- MCP write tools accept an optional `idempotencyKey` argument (1–200 characters); it is passed to the executor and is not part of the command's own input. Tools whose input already has an `idempotencyKey` (a send, a bulk enrollment) keep that field's meaning. Read tools are unchanged.
- The typed client exports `callWithRetry`, which mints one key per logical call and retries a network failure or an in-progress conflict with the same key (five attempts, about 12 seconds), and never retries the reused-key conflict or another 4xx. `conflictReason` and `isIdempotencyInProgress` are exported for custom loops.
