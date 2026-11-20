---
section: Fixed
issues: [1053]
---
- A staged send's canary check now judges the messages the send actually selected, even when the
  segment still lists a profile that merged away. A bounce, complaint or unsubscribe from such a
  canary message counts towards the breach thresholds, so a bad canary no longer releases the rest
  of the audience.
