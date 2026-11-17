---
section: Fixed
issues: [1011]
---
- Journey steps keep a person's traits consistent with a profile merge. A participant is entered on the surviving profile, a "set trait" step writes to the surviving profile and reports a skip instead of success when the person is gone, and a merge can no longer overwrite a trait a journey wrote while the merge was running. A journey sweep and an SDK batch that merges a person no longer deadlock, an AI decision step that finishes at the same moment no longer deadlocks either, and a journey step is skipped once when a person is mid-merge instead of stalling.
- A person is entered into a journey once per event, even when the event is delivered again: an `after_exit` journey no longer creates a second participant for the same event, and an event cannot wake the wait it just created.
