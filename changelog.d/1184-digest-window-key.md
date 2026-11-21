---
section: Fixed
issues: [1184]
---
- A daily agent digest that only partly delivered is now retried for the same window, so a retry
  after UTC midnight reaches only the sponsors whose mail failed instead of sending the digest to
  the ones who already received it.
