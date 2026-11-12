---
section: Fixed
issues: [582, 585, 599]
---
- The broadcast composer now follows a template that was republished elsewhere: its checklist, consent evidence and preview re-read the new live version, and Refresh checks re-reads the template even when the publication pointer has not moved.
- The composer preview distinguishes a segment that is still loading (“Segment…”) from one that could not be read (“Unavailable reference”), instead of calling a fresh selection dead while its name resolves.
- A segment estimate now records the published versions of the referenced segments it was counted from and turns into a previous estimate when one of them is republished, including when the change happened in another tab.
