---
section: Fixed
issues: [1102]
---
- List membership rows that a merge left on a merged-away profile before the 0.17.1 fix are repaired
  once on upgrade: they move to the surviving person, the earliest addition and its source are
  kept, and a duplicate when the survivor was already on the list collapses. Until now such rows
  were invisible to every read, and removing the person from the list could not delete them.
- Refreshing a segment whose saved definition no longer parses, and editing a legacy list from the
  audience commands, now answer a clear "this definition is from an older release, re-save it"
  error instead of "has no published version" or an internal server error.
- A queued `segment_change` payload is now validated in full before it is published, like a queued
  message event: a corrupt row is failed permanently and stays visible for inspection instead of
  reaching subscribers as a half-formed event.
- Adding people to a static audience now reports `added` and `existing` counts that add up to the
  number of people the selectors matched, even when a merge lands during the call and folds two
  matched ids into one person.
