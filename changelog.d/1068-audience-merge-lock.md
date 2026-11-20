---
section: Fixed
issues: [1068]
---
- Adding people to or removing people from a static or snapshot audience now takes the workspace identity lock and follows each person to their surviving profile under it, so a merge that commits while the call is in flight can no longer leave a membership row on a merged-away id that no send, estimate or membership read ever sees.
