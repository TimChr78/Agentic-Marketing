---
section: Fixed
issues: [671, 672]
---
- A changelog fragment is folded once, not twice: resuming an interrupted release matches a fragment on its section and bullet text, so a `Security` entry that repeats an `Added` bullet keeps its section and its issue number, and a folded fragment that names an issue the section's marker lacks adds it before the fragment is deleted.
- The release version is checked against the full SemVer 2.0.0 grammar in one script that the workflow's first job calls, so `0.14.3-..`, `01.2.3` and `1.2` fail the release before anything is built (`prepare.mjs` and the changelog fold use the same check).
- An SMS body that splits its opt-out instruction with carrier boilerplate ("Reply STOP. Msg & data rates may apply. To opt out") no longer gets a second footer; a body with no instruction still gets one, and the match stays linear.
- Consent proof shown to a role without `profiles:pii` no longer includes a free-text import label, which can name a person: it shows the fixed label "Imported" and marks the proof as withheld. A role with `profiles:pii` still sees the original label.
