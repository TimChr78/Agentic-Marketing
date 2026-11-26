---
section: Fixed
issues: [1242]
---
- A journey AI or decision step whose recent-event read fails is no longer answered as if the person had no history: the failure leaves the call for its next attempt instead of calling the model blind and billing it.
