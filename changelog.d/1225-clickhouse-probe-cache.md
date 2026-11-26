---
section: Fixed
issues: [1225]
---
- A ClickHouse request that fails while the event store is still finding out whether the server accepts its `SQL_workspace` setting no longer poisons every later read. Only the server's own "unknown setting" answer is remembered as "not accepted"; a dropped connection or a timeout fails that one request, and the next one asks again. Where row policies are required, a server that stops accepting the setting now fails the read instead of silently returning an empty workspace.
