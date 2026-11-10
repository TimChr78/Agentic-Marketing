---
section: Security
issues: [608, 609, 610]
---
- Public traffic served under a registered path prefix keeps the visitor's client IP, so form submissions are rate-limited per visitor, Turnstile receives `remoteip` and consent records keep their address evidence. Such requests are also counted once in `/metrics`, under the public route group rather than the admin UI, and unmatched `/hooks` and `/scim` paths answer JSON instead of the admin page.
