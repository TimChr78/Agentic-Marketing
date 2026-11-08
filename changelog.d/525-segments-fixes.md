---
section: Fixed
---

- Segment estimates belong to the rules they were requested for: changing the condition marks the old count as a previous estimate instead of showing it as current, and a response that lands after an edit or a newer request is ignored. Refreshing the shared picker index now carries a request generation, so an older in-flight read can no longer overwrite newer rows. A family list that opts into the Phase 27 template reads through the shared picker index, so Segments with the snapshot-source picker open makes one segment list read instead of two; the Phase 24–26 list path is unchanged. The segment Preview tab now says it shows the saved version and points to Content → Estimate audience for unsaved rules.
