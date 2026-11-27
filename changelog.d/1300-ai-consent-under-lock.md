---
section: Fixed
issues: [1300]
---
- Every write of an AI score or a classified label re-checks the person's AI consent under the lock it writes behind, so a consent change (a withdrawal or an objection) that commits while the write waits can no longer store the result. A withheld score is recorded as a fallback on a journey decision step, which then takes its fallback edge.
- A journey step reads consent again after it has built the person's context, and rebuilds it for the survivor when a merge lands in between, instead of sending the merged-away profile's cleared traits or reusing the empty-segment text cache.
- The journey sweep reads consent, segment membership and branch conditions with the canonical profile it locked, so a participant left on an id an earlier merge folded away follows the person's current consent.
