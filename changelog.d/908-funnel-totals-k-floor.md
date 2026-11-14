---
section: Security
issues: [908]
---
- **Breaking:** `analytics.journeyFunnel` applies the k=5 floor to its headline totals, not only to the step rows beside them. Step rows follow the published topology (a fork’s branches add up to their parent, a reconvergence’s parents to the node), so one hidden branch hides the smallest visible term of the same relation, never an unrelated step. Headlines are not modelled — how they relate to the steps cannot be known in general — so whenever any step row is hidden (below k or as a complementary row) every headline total (`entered`, `goalReached`, `completed`, `exited`) is withheld as `null`; a positive headline below k is withheld on its own. Over-suppression is deliberate, and a note says a hidden step withheld the totals. Drop-off and drop-off rate with a hidden operand stay `null`. API clients must handle four more nullable fields, and the journey report renders a withheld total as suppressed.
