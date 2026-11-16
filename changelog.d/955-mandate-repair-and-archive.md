---
section: Fixed
issues: [955]
---
- The start-up single-active-mandate repair no longer records a workspace as repaired when a duplicate-mandate group has no usable mandate: it archives nothing, logs the group once per pass and looks at it again on the next start, so a later release (or a person fixing a row) is not blocked by a `data_repairs` marker written years earlier. A workspace recorded by an older release is re-examined once after upgrading.
- New `artifacts.archive` (people only, audited) retires an artifact: it can no longer be published, the default `artifacts.list` hides it (`includeArchived` shows it), and its pending approval requests are closed as rejected. The "agent … already has an active mandate" refusal now names that command, so a duplicate published mandate can actually be archived before its replacement is published. A workspace singleton (brand, business context, tracking plan, purposes, delivery policy, conversion map) cannot be archived, since a workspace needs it; there is no unarchive command, and a live version is not unpublished by archiving.
