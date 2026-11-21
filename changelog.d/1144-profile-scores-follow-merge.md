---
section: Fixed
issues: [1144]
---
- Predictions stored for a person now survive an identity merge: the newest score per key moves to the surviving profile, so segments, journeys, `profiles.scores` and `ai.calibration` keep reading the same person's scores. `profiles.scores` also follows a merge when called with an old profile id.
