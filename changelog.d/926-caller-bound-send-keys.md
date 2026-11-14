---
section: Fixed
issues: [926]
---
- The input-level idempotency key of a direct send (`messages.sendEmail`, `messages.sendSms`, `messages.sendPush`) and of `journeys.enrollSegment` is bound to an immutable request fingerprint: the caller plus the recipient, template and template variables as supplied (or the journey, segment, versions and limit). A different caller, recipient, template or data answers `409` with `details.reason: "idempotency_key_reused"` and never receives the first caller's message decision or job.
- The fingerprint is taken before any resolution, so an identical retry that still names a profile id since merged into another person replays the message that was queued.
- Journey steps, broadcasts, double opt-in confirmations and other internal sends fingerprint only immutable identifiers (submission event id and form, journey and enrollment and node, broadcast and recipient row, test address, alert), never a resolved profile id, a template version or an assigned subject variant, so a worker retry, a redelivery after a profile merge, or a re-rendered subject still replays one message. Concurrent requests with one input-level key serialise before the lookup: one message, a replay for the same request and a `409` for a different one, never a database error.
- Message rows written before the fingerprint was stored match a key on their stored recipient and template columns, as documented; no existing row is rewritten.
