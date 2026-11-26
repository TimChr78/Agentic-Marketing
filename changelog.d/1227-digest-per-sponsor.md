---
section: Fixed
issues: [1227]
---
- The daily agent digest tracks each sponsor's own window. A sponsor who can never be mailed (a
  removed member, or an address the provider refuses) no longer stops every other sponsor's
  digest, and the ledger read behind an open window stays bounded. A digest sent by the previous
  release is read at the time it was sent, so the next digest still goes out after an upgrade.
