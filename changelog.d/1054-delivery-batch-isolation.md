---
section: Fixed
issues: [1054]
---
- A delivery worker no longer drops the rest of a claimed batch when one message hits an unexpected error. A message that failed before any provider call goes back to the queue with its normal backoff and attempt budget; once the provider may have been reached, only that message is marked failed with an "unknown outcome" reason, so nothing is retried into a possible duplicate.
