---
section: Fixed
issues: [1028]
---
- A worker stops promptly when its event-bus connection is reconnecting: it ends the batch it is waiting on instead of holding the shutdown for a pull that cannot complete, and the messages it had not acked are redelivered. A back-off after a failed pull is cut short by the same signal (#1028).
