---
section: Security
issues: [1135]
---
- The browser SDK sends a visitor's user id to `/v1/decide` only when the `web_personalization` purpose is allowed; analytics consent alone no longer identifies them. Withdrawing `ad_measurement` now clears the in-memory ad click ids and removes them from events already queued, before the queue is sent.
