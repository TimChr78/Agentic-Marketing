---
section: Fixed
issues: [1152]
---
- An unsubscribe link for a person who was erased, or whose message row is gone, no longer writes a message event or a consent-change notification for the erased profile. When the person was merged, the event and the notification use the surviving profile.
