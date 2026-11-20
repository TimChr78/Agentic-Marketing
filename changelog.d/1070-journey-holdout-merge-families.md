---
section: Fixed
issues: [1070]
---
- `journeys.holdoutResult` now resolves a person's merge family the same way the campaign report
  does: one person counts once with their earliest assignment, and a conversion or unsubscribe
  recorded under an id that was merged away still counts for the survivor.
