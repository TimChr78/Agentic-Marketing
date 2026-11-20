---
section: Fixed
issues: [1142]
---
- An `alias` event that names its own identifier no longer crashes the profile worker. The batch resolves instead of being redelivered forever, so identity resolution, segments, webhooks and journeys on that shard keep moving.
