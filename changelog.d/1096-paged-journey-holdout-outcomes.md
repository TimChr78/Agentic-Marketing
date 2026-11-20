---
section: Changed
issues: [1096]
---
- `journeys.holdoutResult` reads a journey's goals and unsubscribes one page of winners at a time,
  scoped to that page's merge family, instead of loading every outcome id for the journey first.
  Memory and the ClickHouse read are now bounded by the page. A page that cannot be resolved says
  why in the note and matches on the stored profile id: either its merge family is larger than the
  supported profile bound, or a family is corruptly deep.
