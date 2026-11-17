---
section: Fixed
issues: [1011]
---
- Journey steps keep a person's traits consistent with a profile merge. A participant is entered on the surviving profile, a "set trait" step writes to the surviving profile and reports a skip instead of success when the person is gone, and a merge can no longer overwrite a trait a journey wrote while the merge was running. A journey sweep and an SDK batch that merges a person no longer deadlock.
