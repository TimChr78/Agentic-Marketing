---
section: Fixed
issues: [961]
---
- On the Recipes page, an install that finishes after a parameter edit is reported instead of dropped: a notice says the earlier install created its drafts, names the parameters it ran with and links each draft, and the values now on screen are not marked as installed. An install that fails for the earlier parameters is shown the same way, labelled as theirs. Nothing changes when the person switches to another starter: a result for the starter they left is still discarded.
- An install and a prerequisite check are now sequenced separately: checking the prerequisites while an install is still running no longer discards the install's drafts and links or leaves Create drafts looking available for a second set.
- Switching starters now invalidates an install still in flight and clears its loading state, even when the person returns to the same starter: the starter reloads its parameter defaults, so a late result is not reported as the current values' install.
