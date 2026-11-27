---
section: Fixed
issues: [1249]
---
- Approving a workspace settings proposal now re-reads the session's workspace immediately. The
  shell name, the display time zone and the Workspace form use the approved values, so a later
  Workspace save no longer sends the old time zone and reverts the approval.
