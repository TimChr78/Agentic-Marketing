---
section: Fixed
issues: [959]
---
- A below-k step whose only parent is itself (a disconnected self-loop, as `journeys.migrate` can leave behind) now gets the suppression note the funnel contract promises: a note names the step and k and says it is its own hidden subtree. A parentless below-k step is named in the all-steps-hidden note as well, so a fully withheld funnel is always explained.
