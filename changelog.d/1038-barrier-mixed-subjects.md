---
section: Fixed
issues: [1038]
---
- A provider webhook batch that spans several broadcasts or journeys is written to the outbox one row per broadcast, so each row carries its `subject_ref`. The publication barrier now sees the whole batch: a staged-send canary check and a subject-test winner wait for a mixed batch's clicks and unsubscribes instead of deciding from incomplete data.
