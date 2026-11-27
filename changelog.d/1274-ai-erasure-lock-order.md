---
section: Fixed
issues: [1274]
---
- A journey AI step (decision, generation or score) that finishes while the same person is being erased no longer deadlocks: the step takes the profile lock, then the participant row, then fences its `ai_calls` attempt, the order erasure uses. The erasure commits, and a step that finds the person gone records nothing.
- `ai.classify` and the SDK `ai.score` path lock the person before writing a call row that names them, so an erasure committing at the same time no longer surfaces a raw 23503 foreign-key error.
