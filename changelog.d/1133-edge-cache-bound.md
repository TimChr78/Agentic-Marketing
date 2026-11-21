---
section: Security
issues: [1133]
---
- The Cloudflare edge worker no longer keeps a cache entry for a write key that does not exist, and its isolate cache has a hard size limit with eviction. Unauthenticated `/v1/decide` requests with random write keys can no longer grow the worker's memory until it restarts.
