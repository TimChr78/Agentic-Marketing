---
section: Fixed
issues: [643, 644]
---
- Signed inbound webhooks remember their `webhook-id` in the shared hot state: a replayed request is answered as already received and publishes nothing, while a delivery still being processed gets a retryable 503 instead of a false acknowledgement, so a crash mid-publish cannot lose the event.
- The browser SDK reads ad click-id cookies without truncating values at `=`: a value that fails the click-id pattern is dropped whole instead of a shortened, wrong id being stored.
