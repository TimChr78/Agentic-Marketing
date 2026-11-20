---
section: Fixed
issues: [1105]
---
- `journeys.splitResult` reads a journey's goals and unsubscribes one page of split participants
  at a time, scoped to that page's merge family, instead of loading every outcome id for the
  journey first. Memory and the ClickHouse read are bounded by the page, and the result is the
  same. A page that cannot be resolved says why in the note and matches on the stored profile id:
  either its merge family is larger than the supported profile bound, or a family is corruptly
  deep.
