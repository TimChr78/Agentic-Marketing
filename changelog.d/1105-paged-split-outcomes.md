---
section: Fixed
issues: [1105]
---
- `journeys.splitResult` reads a journey's goals and unsubscribes one page of split participants
  at a time. Each page resolves its own merge family and drops it again, so memory and the
  ClickHouse read are bounded by the page, not the journey's whole history. A page that cannot be
  resolved says why in the note and matches on the stored profile id: either its merge family is
  larger than the supported profile bound, or a family is corruptly deep.
- A split unsubscribe stored under a merged-away id now counts for the person it became, as it
  does in the holdout report, and the k=5 floor counts people rather than ids, so one person with
  two merged ids is one person and an arm of five entries can still be hidden.
