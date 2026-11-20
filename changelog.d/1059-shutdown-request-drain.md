---
section: Fixed
issues: [1059]
---
- Server shutdown now stops accepting connections and waits, bounded, for requests that are already being served before it closes the workers, pools and clients. An idle keep-alive connection is dropped at once, and a request still running at the bound is force-closed, so deploys and `docker compose stop` no longer cut off a form submission, an API write or an agent turn mid-request.
