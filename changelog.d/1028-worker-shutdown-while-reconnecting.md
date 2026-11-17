---
section: Fixed
issues: [1028]
---
- A worker stops promptly when its event-bus connection is reconnecting instead of waiting for a pull request that cannot complete, so a restart or shutdown is not held up by a consumer whose server is not there yet (#1028).
