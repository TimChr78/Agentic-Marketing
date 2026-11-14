---
section: Security
issues: [932]
---
- The generic `/api/auth/*` catch-all now refuses a request body over 256 KiB with a JSON `payload_too_large` 413 before Better Auth reads it. Sign-in, sign-up, OAuth token and SSO registration were previously buffered whole, so an unauthenticated caller could exhaust the server's heap with an oversized or endless chunked body; a normal sign-in, a chunked request without `Content-Length` and the existing consent and password-reset limits behave as before.
