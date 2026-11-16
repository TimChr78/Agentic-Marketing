---
section: Fixed
issues: [944]
---
- A broadcast no longer sends a person a second time when two of their profiles merge while the run is in flight. The run asks whether the person already has a message for this broadcast — under the id the audience lists or under any profile that id was merged into — instead of relying only on a key that embedded the merge-rewritten profile id, so a survivor the run had not reached yet and a merged-away id the audience still lists are both left alone. A run that was mid-flight during the upgrade keeps the messages it already queued.
- The check is ordered against identity resolution: the batch takes the same per-workspace identity lock a merge takes, so a merge either commits before the batch looks or waits for it, and can no longer land between the check and the insert. The batch also resolves every member to the person the send will reach, so an audience that lists two aliases of one person (a dynamic segment keeps both until its next refresh) is one recipient: exactly one message, and one decision recorded per person.
- A test send no longer counts as the person's message for a run: a subject test's sample pass, a staged send's rest pass or a replayed chunk can no longer skip someone only because a copy was test-mailed to them.
