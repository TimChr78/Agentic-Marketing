---
section: Fixed
issues: [944]
---
- A broadcast no longer sends a person a second time when two of their profiles merge while the run is in flight. The run asks whether the person already has a message for this broadcast — under the id the audience lists or under any profile that id was merged into — instead of relying only on a key that embedded the merge-rewritten profile id, so a survivor the run had not reached yet and a merged-away id the audience still lists are both left alone. A run that was mid-flight during the upgrade keeps the messages it already queued.
- A test send no longer counts as the person's message for a run: a subject test's sample pass, a staged send's rest pass or a replayed chunk can no longer skip someone only because a copy was test-mailed to them.
