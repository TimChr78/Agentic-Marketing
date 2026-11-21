---
section: Fixed
issues: [1144]
---
- Scores left on a profile that a merge folded away before this release are moved to the surviving profile when the upgrade migrates the database, keeping the newer score per key, so segments, journeys, `profiles.scores` and `ai.calibration` see them again without a re-score.
