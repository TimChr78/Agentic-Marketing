---
section: Security
issues: [932]
---
- The generic `/api/auth/*` catch-all now refuses a request body over 256 KiB with a JSON `payload_too_large` 413 before Better Auth reads it. Sign-in, sign-up, OAuth token and SSO registration were previously buffered whole, so an unauthenticated caller could exhaust the server's heap with an oversized or endless chunked body. The SAML ACS and SLO callbacks keep their own larger ceiling, derived from the 262,144-byte `SAMLResponse` limit and worst-case form encoding, so a valid maximum-size response still works. The shared body guard now counts actual bytes for every request, including one whose `Content-Length` understates the body, and a route sweep fails CI when a body-accepting route has no limit.
