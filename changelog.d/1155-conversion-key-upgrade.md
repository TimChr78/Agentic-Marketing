---
section: Fixed
issues: [1155]
---
- Ad conversions queued before this release have their delivery key rewritten at upgrade to the format that names the destination action, so a batch redelivered after the upgrade does not send a conversion twice. A conversion that was already redelivered keeps one delivery instead of a second pending copy.
