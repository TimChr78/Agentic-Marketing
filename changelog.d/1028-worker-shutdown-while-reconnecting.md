---
section: Fixed
issues: [1028]
---
- A worker stops promptly when its event-bus connection is reconnecting: it ends the batch it is waiting on, no longer waits for a consumer setup that cannot complete, and the messages it had not acked are redelivered. A back-off after a failed pull is cut short by the same signal (#1028).
