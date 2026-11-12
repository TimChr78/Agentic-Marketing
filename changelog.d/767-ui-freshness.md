---
section: Fixed
issues: [767, 768, 770, 771, 791, 792]
---
- The broadcast composer re-reads its template and segment, and re-runs the evidence and audience estimate, when the window regains focus: a template or segment republished by another tab, person or agent no longer leaves "Live vN · Ready" evidence describing an older send.
- An artifact change now names the artifact it changed, so saving a broadcast no longer forces the composer to re-read its template and segment or flips both evidence rows to "Checking"; the explicit "Refresh checks" still bypasses the cache.
- Reference pills such as "Live vN" in a form or broadcast preview, and the shared artifact-name lookup, update after an in-tab publish or rename instead of staying on the pointer they first read.
- Segment estimates track the membership of referenced static lists and snapshots: `segments.preview` reports a list's membership stamp and the editor turns a count into a previous estimate after an import, even though the list's published version did not move.
- A malformed percent escape in a route parameter (`/artifacts/%`) keeps the raw segment and shows the page's recoverable error, and a root error boundary replaces a blank page with a retryable error when a route throws.
- Starter "Check prerequisites" and "Create drafts" results are sequenced like the detail read: a slower earlier starter can no longer show its prerequisites, draft list or created artifacts under the newly selected starter.
