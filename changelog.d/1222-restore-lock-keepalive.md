---
section: Fixed
issues: [1222]
---
- The connections that hold the restore interlock now use TCP keepalive and answer a periodic liveness query, so a connection lost without a close is noticed: the server logs it and exits instead of serving without the lock, and `am restore`/`am migrate` take the same lock-loss path instead of waiting forever on a peer that is gone.
