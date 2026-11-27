---
section: Fixed
issues: [1300]
---
- Every write of an AI score or a classified label re-checks the person's AI consent under the lock it writes behind, so a consent change (a withdrawal or an objection) that commits while the write waits can no longer store the result. A withheld score is recorded as a fallback on a journey decision step, which then takes its fallback edge.
- A journey step reads consent again after it has built the person's context, and rebuilds it for the survivor when a merge lands in between (including a merge into the survivor, which keeps its id but rewrites its traits and moves the merged profile's identifiers), instead of sending the merged-away profile's cleared traits or reusing the empty-segment text cache.
- A decision or generated text is committed to the journey participant only while the person's AI consent still allows it. A withdrawal or objection that lands while the model runs turns the step into a fallback: the participant takes its fallback edge, no decision or generated text is kept, the call's log drops the answer, its rationale and the person context it was given, and the provider usage is still recorded.
- The journey sweep reads consent, segment membership and branch conditions with the canonical profile it locked, so a participant left on an id an earlier merge folded away follows the person's current consent.
