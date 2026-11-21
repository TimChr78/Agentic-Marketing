---
section: Fixed
issues: [1197]
---
- A dynamic segment's member total no longer keeps counting an erased person until the next recompute: the erasure transaction removes the memberships and decrements the stored total by the same amount.
