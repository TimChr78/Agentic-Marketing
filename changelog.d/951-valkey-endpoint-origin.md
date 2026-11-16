---
section: Fixed
issues: [951]
---
- `am doctor` reports a `redis://`, `rediss://`, `valkey://` or `nats://` endpoint as `scheme://host:port` (never its userinfo, path or query) instead of `(invalid URL)`, and a failed Valkey check names the endpoint it could not reach. A connection failure inside an `AggregateError` or a chain of causes now reports the nested code (`ECONNREFUSED`, `ETIMEDOUT`), so an unreachable Valkey reads as a host and a reason rather than a malformed URL.
