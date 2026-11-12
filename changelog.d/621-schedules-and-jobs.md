---
section: Fixed
issues: [621, 622, 628, 642]
---
- An hourly hosted agent now runs at minute 0 of every hour in the workspace's time zone instead of only at midnight, and its next run is computed by jumping to the boundary rather than scanning minutes, so creating or running a weekly agent no longer stalls the server for about a second.
- Two segment refreshes in the same minute now both publish their Segment Entered and Segment Exited events, so a journey triggered by a quick re-entry is no longer lost to the event bus's duplicate window.
- An independent model check that cannot record its usage now keeps its AI budget reservation through the billing month, so the tokens the provider billed are no longer counted nowhere.
