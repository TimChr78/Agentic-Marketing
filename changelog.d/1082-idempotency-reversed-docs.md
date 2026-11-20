---
section: Fixed
issues: [1082, 1055]
---
- The REST `idempotency-key` header and the MCP `idempotencyKey` argument now describe the `idempotency_key_reversed` 409, and the architecture overview says that a key is remembered for 30 days (`RETENTION_IDEMPOTENCY_DAYS`) instead of for the life of the workspace.
