---
section: Fixed
issues: [1274]
---
- A journey decision step that finishes while the same person is being erased no longer deadlocks: the step takes the profile lock before it fences its `ai_calls` attempt, the order erasure uses. The erasure commits, and a step that finds the person gone records no score.
