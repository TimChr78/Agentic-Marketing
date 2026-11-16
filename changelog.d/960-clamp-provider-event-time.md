---
section: Fixed
issues: [960]
---
- A provider callback's own time is clamped to now before anything is written, not only where consent precedence is at stake: the message event, `messages.sentAt` and the suppression row now carry the same bounded instant, so a replayed or misconfigured webhook with a far-future `at` can no longer put an impossible date on the suppression list or skew deliverability trends bucketed on the event time. A past `at` is kept exactly as the provider reported it.
