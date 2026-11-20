---
section: Fixed
issues: [1073, 1072, 1076]
---
- Segment time windows are capped at 10 years when a segment is saved, so a look-back ClickHouse cannot bind can no longer be published and fail on every evaluation. Message engagement now counts distinct messages rather than engagement events, so two opens of one issue (a mailbox that pre-fetches the pixel) or two clicks on one link count once. A new message window longer than the 25 months of message history that is kept is refused at save, and the builder says that a rule without a window reads those 25 months.
- Republishing a segment version that already holds a window longer than 25 months is refused as well, with the fix in the message; the version keeps working until then.
- A segment saved with a window beyond the new 10-year cap stays readable: its stored members are still listed, and previewing it answers a clean “re-save it” error instead of a 500.
- One segment that cannot be evaluated no longer stops the refresh of the workspace's other segments, or the refresh of other workspaces, and an already saved definition that no longer parses is skipped and logged instead of taking the round down. An unsubscribe that has committed stays a success even when the segment re-evaluation fails.
