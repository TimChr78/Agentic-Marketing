---
section: Fixed
issues: [926]
---
- The input-level idempotency key of a direct send (`messages.sendEmail`, `messages.sendSms`, `messages.sendPush`) and of `journeys.enrollSegment` is now bound to the caller and to the request. A different caller, recipient, template, journey or segment using the same key answers `409` with `details.reason: "idempotency_key_reused"` and never receives the first caller's message decision or job.
- Journey steps, double opt-in confirmations and other internal sends keep working: they use one system identity and their own generated keys.
- Message rows written before the caller was recorded match a key on their input alone, as documented; no existing row is rewritten.
