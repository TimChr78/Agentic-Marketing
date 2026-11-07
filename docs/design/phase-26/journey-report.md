# Journey report · #507

Build on pages/build/JourneyPage.tsx Report tab, not a new stats destination. Counts appear on
canvas nodes through the existing JourneyGraph and an equivalent step list.

## Period and exact reads

All reads artifacts:read. Reuse host artifacts.get({artifactId:journeyId}) for publication pointer;
if publishedVersion differs from the returned version, one artifacts.get({artifactId,version:
publishedVersion}) for topology. Never load all journeys in embedded mode. With published version
in hand, exactly 1 journeys.stats({artifactId:journeyId}) + 1 analytics.journeyFunnel({journeyId,
from,to}) = 2 report reads; optional pinned topology = 1 extra, host read excluded. Funnel wrapper
internally runs two analytics queries, not N step reads. Refresh reruns the two report calls only.
No publication: show draft/no live topology; stats may still contain historical counts, retain a
separate unmapped history list. No fabricated live zero counts. Goal/control configured: one optional
journeys.holdoutResult({journeyId,from,to}) loaded on expanding Holdout, not per step or split.
No split-result calls in this scope. No prior-period report comparison. Builder’s optional Counts overlay uses exactly1 journeys.stats
read when enabled on a published, unmodified topology; share it with its settings summary instead
of another stats fetch. Remove the existing30s timer in favour of explicit Refresh. Report and
builder do not run while inactive; if both remain mounted use a shared per-journey result. Builder
purposes/names/authoring reads are existing editor work, excluded from this report budget.

## Sections and cuts

Current participants: now.ready/waiting/failed/completed/exited/converted exactly as returned,
label each state; these are present snapshot counts, not the selected-period totals. Skip facts
(duplicatesSkipped,missingKeySkipped) retain all-time labels. stats.waitingAt=node current waiting;
stats.reached=node all-time distinct participants, max(step,resumed) semantics. “Latest event in
period: Unavailable” for stats, optionally fetched-at. No visits or version-cohort claims.

Period result: entered,goalReached,completed,exited and steps[].reached; conversion displays
 goalReached/entered with both bases, unavailable when entered=0. Event dates differ from entry
cohort dates; ratio may exceed100%. meta from the wrapper is step-result freshness, caption
“Latest event in period (step events)” rather than implying totals freshness. Totals freshness
is unavailable. Wrapper coerces absent totals to0; when result/meta cannot establish an observed
value show unavailable, do not reconstruct suppressed totals. Retain meta.notes/k/suppressed.

Use published node names only for known ids; unresolved old nodes say “Historical step · name
unavailable”, with Identifier copy affordance. No newer draft names on old events. Version
provenance is not available on aggregate counts: even matching ids cannot prove version-specific
counts. Canvas badges say “All versions · reached all time / waiting now”. Draft canvas gets no
count overlay. Node ids remain behind copy controls.

**Funnel gate:** a single linear published graph, no branches/loops/splits, all event step ids
mapped, topology provenance compatible (require latestVersion=publishedVersion=1 for this phase), every stage present and
unsuppressed, entered>0, monotone counts. Otherwise horizontal independent bars and explanation:
“Step reach is not a cohort funnel.” With no aggregate version provenance, any additional saved version
fails the gate because aggregate version attribution is unavailable. A passing diagram is titled “Sequential event reach”, not an entry cohort;
exclude goal/completed/exited as sequential stages because goal can occur independently. Use graph
order, not event-id sorting; recalculate adjacent reach differences only for passing steps, label
previous-stage denominator. Negative differences fail gate; never clamp them. Universal funnels,
per-version attribution and independent journey pause/stopped semantics are cut.

1440: step visual/main with320px current-state context, canvas badges nearby. 768: context below,
step list before optional canvas. 390: readable step list is primary, canvas in labelled scrollable
region, no mandatory pan to read counts; one-column tiles. Funnel/bar table gives every step’s
period reach alongside explicitly separate all-time reach and waiting-now columns.

## Data states and access

Apply the README shared contract in full. Loading: section-sized skeleton and aria-busy;
empty: keep period/filter controls and explain no recorded activity; observed zero: numeric 0
only when explicitly returned by a successful read; null/missing: em dash and Unavailable;
suppressed: em dash and server k/notes, never infer hidden values. Partial failures stay local
with Retry; stale responses cannot replace a newer selection. On refresh remove current-value
claims from old data. Restricted sections issue zero reads and contain no hidden payload.
Not found is distinct from empty. No event timestamp means “Latest event in period: Unavailable”;
operational reads may additionally show “Computed at” or “Checked at”. Never render epoch dates.

## Keyboard, focus and chart alternatives

Native labelled controls; 40 px targets; visible 2 px accent focus with 2 px offset. Tabs use
arrow keys/Home/End and roving tabindex; Tab enters the selected panel. Filter changes retain
focus and announce completion politely. Retry retains focus; pagination moves focus to the
list heading after success and announces rows shown. Dialog Escape returns focus to its trigger.
No hover-only values: every chart has a named figure, units, textual summary and visible table
below from the same returned values, including missing/suppressed cells. Keyboard-accessible
legend toggles never remove data from the table. No smoothed lines, mixed-unit axes or silent
zero fill. Dates and numerals wrap; tables become labelled row stacks on phones. Use v2 viz
colours with markers/dashes and labels; colour alone conveys nothing.

## Tests the build must add

Add request-spy tests for the exact budget above, zero denied reads and no per-row requests;
loading, empty, observed zero, null, suppression, local error/retry, stale-response and not-found
fixtures. Assert period/denominator/freshness captions, no raw keys/ids outside copy controls,
and chart/table parity. Add both-theme 1440/768/390 screenshots and axe coverage via integration
ownership; manual keyboard, focus return, 200% zoom and screen-reader checks are required.
Tests listed below are additional surface-specific acceptance, not replacements for these checks.

Test embedded mode has no artifacts.list; current/all-time/period separation; no per-node fetch; branched, looped, historic/unmapped, suppressed and nonmonotone graphs fail funnel gate; draft/live topology mismatch and wrapper freshness qualification.
