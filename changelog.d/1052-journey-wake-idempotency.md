---
section: Fixed
issues: [1052]
---
- A redelivered event can no longer satisfy a later wait or goal that listens for the same event
  name. An event that wakes a waiting participant now gets the same processed marker as one that
  enrols somebody, so it is applied exactly once.
