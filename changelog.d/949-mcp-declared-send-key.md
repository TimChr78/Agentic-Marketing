---
section: Fixed
issues: [949]
---
- An MCP client cannot send a key the strict rule refuses to a tool that declares its own `idempotencyKey`: `messages.sendEmail`, `messages.sendSms`, `messages.sendPush` and `journeys.enrollSegment` are validated like every other write tool now, so a key with spaces or outside 1–200 printable ASCII characters answers `400 invalid_input` instead of reaching the send's lock key. The REST command's own `idempotencyKey` field keeps its 1–200 character bound for compatibility, so a value with spaces still works there.
