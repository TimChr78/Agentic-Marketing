---
section: Fixed
issues: [1154]
---
- An inbound SMS STOP and an SMS complaint or unsubscribe callback now refresh consent-dependent segments and journey audiences straight away, as e-mail unsubscribes already did. Tracked click links whose URL uses an uppercase `HTTPS://` scheme now redirect instead of returning 404.
