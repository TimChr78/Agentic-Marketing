---
section: Fixed
issues: [592, 593, 625, 626]
---
- Personal-data reads now write an audit record: `profiles.find`, `profiles.events`, `consent.history`, `topics.preferences`, `messages.list`, `segments.ofProfile`, `profiles.scores`, `deliveries.list`, `segments.preview` (its sample is profile ids) and `journeys.simulate` (with the person as the target when a profile is given).
- The person page shows the consent delivery actually enforces, per purpose and per channel, so a newer withdrawal on one channel is visible beside the channels it did not touch and an equal-timestamp refusal wins.
- `journeys.simulate` asks the same channel-precedence rule as the runtime, so a webhook withdrawal behind an older all-channel grant previews as “would not send” instead of “would send a webhook”.
