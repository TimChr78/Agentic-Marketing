---
section: Fixed
issues: [985]
---
- A holdout send and its report now resolve a person's merge family the same way. A chain longer than the old 20-hop forward walk, or a merge cycle, can no longer hold someone out of a send while the report counts them as two people.
