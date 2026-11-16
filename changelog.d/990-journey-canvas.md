---
section: Fixed
issues: [990]
---
- The journey canvas no longer loses its node measurements on every re-render. The graph rebuilt its nodes each time it rendered without warnings, so React Flow could re-adopt them unmeasured and leave them hidden: the builder or read-only canvas could show no visible steps until something else made it measure again. The node list is now stable, and the canvas marks itself ready (`data-journey-ready`) once every node has been measured.
