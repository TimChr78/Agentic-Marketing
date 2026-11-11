---
section: Fixed
issues: [643, 644]
---
- Signed inbound webhooks remember their `webhook-id` in the shared hot state, so a captured request replayed within the signature tolerance window is answered as already received and its events are not published twice.
- The browser SDK reads ad click-id cookies without truncating values at `=`: a value that fails the click-id pattern is dropped whole instead of a shortened, wrong id being stored.
