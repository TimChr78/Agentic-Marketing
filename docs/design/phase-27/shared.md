# Phase 27 · shared interfaces and acceptance

## Shared reads, artifact host and preservation

Budgets count client command calls, excluding the single existing session/workspace bootstrap.
A list L(type) means `artifacts.list({type,limit:200,cursor?})` once per returned page, sequential
cursors, maximum existing 100-page guard. Preserve complete name/publication filtering by using
that bounded complete index, cached once per type per workspace; show “X of Y loaded” and limited
search warning at the guard. Do not replace it with a silently truncated first page. No row gets
`artifacts.get`. Pickers share L(type), not one index per condition/node. Search/filter on loaded
complete index costs zero; refresh repeats L. This is pagination, not an N+1 detail scan.

Artifact detail H(id): `artifacts.get({artifactId:id})` once and
`approvals.list({status:'pending',artifactId:id,limit:5})` once =2. Rejected version adds exactly one
`approvals.list({status:'rejected',artifactId:id,limit:1})`. Versions tab adds one `artifacts.history`;
opening a version adds one `artifacts.diff({artifactId,from?,to})`; its Content tab adds one pinned
`artifacts.get({artifactId,version})`. Activity adds three `approvals.list` (pending/approved/rejected,
limit50), plus one `audit.list({target:id,limit:100})` only with audit:read. No per-version eager
content/diff reads. Cache pending list when its exact parameters match; do not assume limit5=limit50.

Preserve name/create dialog, name/publication filters, totals/completeness, author/version/date,
identifier copy, canonical links and consumed create intent. Every detail uses DetailPage slots
without losing Content, Preview where supported, Versions/diff/version content, Activity/reviews/
audit, advanced JSON where currently offered, rename, Save draft, Discard changes, discard saved
draft back to live, review link, Publish/Submit for review and required change note. More actions preserves Rename, Discard draft back to live and
Copy identifier.
No archive/restore command or new action is introduced. Keep server warnings and approval policy gating;
publication is not a new operational state. `artifacts.create`, `artifacts.updateDraft`,
`artifacts.discardDraft`, `artifacts.requestPublish` remain their existing
mutations; refresh only affected H/list reads, not other rows. Builder artifacts:write, publish
artifacts:publish, review artifacts:approve, audit audit:read; no role-name shortcut grants rights.
Previews retain Unsaved draft / Saved vN / Published vN source labels and Phase 25 blocked-draft
fallback; never silently show a saved frame beneath an unsaved label.

## Data states and access

Loading reserves section geometry with aria-busy. Empty configuration offers the existing create
flow; filtered empty offers Clear filters. Error replaces affected values with Retry; independent
panels remain usable. Restricted deep links explain the role and issue zero denied reads, with no
hidden payload. Not found is distinct from empty and offers the parent destination. Read-only
keeps all readable fields, previews and history; mutation controls are absent. Preserve draft,
in review, rejected with decision note, published with newer draft, archived, dirty, saving,
save failure and optimistic conflict states wherever the artifact host applies. Never discard
unknown content properties or unsupported condition shapes during a round trip. Conflicts retain
local input and offer reload/review; never silently overwrite. On selection change ignore stale
responses; refresh errors must not leave old numbers labelled current.

Observed zero requires a successful result; missing/null is Unavailable. Suppressed values stay
hidden in tiles, tables, exports and accessible text. Do not invent suppression on operational
sources. No epoch dates or fake freshness; name the actual source timestamp or say unavailable.
Metrics name units, period, denominator and freshness; snapshots are not trends. Fractions ×100,
rate differences in percentage points, previous zero means no comparable baseline. No new chart
is required unless the contract names one; every chart has a visible native table of the same
values and missing/suppressed states, never mixed units or silent zero fill.

## Responsive geometry

1440: real grouped shell, existing page cap; detail main 800 / gap 24 / context 320 where applicable.
768: compact shell, context below, two-column previews where they fit. 390: one shell menu toggle,
16 px gutters / 358 px content, one-column labelled row summaries preserving every desktop field
and action. Tables and canvas alone may scroll in named focusable regions; no page-level horizontal
overflow. Dialogs/drawers become full width. Targets at least 40 px below 768 and for coarse pointers.
Tenant colours stay inside recipient previews, never admin navigation. Use DESIGN v2 light/dark
tokens, system fonts, 24/32 headings, 14/22 reading, 13/20 dense rows, 8–12 px corners, no card shadows.

## Keyboard, focus and chart alternatives

Native labels and fieldset legends; 2 px accent focus / 2 px offset. Tabs use arrows/Home/End and
roving tabindex; only selected panel mounts. After failed submit focus an error summary linked to
fields, retaining input. Retry retains focus and announces outcome politely. Dialog traps focus,
Escape closes when safe and returns focus to trigger; destructive confirmation states consequence.
Paging announces count and focuses list heading on success. No hover-only warning, metric or action.
Reduced motion disables transitions and canvas animation. Screen-reader names never expose hidden PII.

## Tests the build must add

Request spies assert the exact budgets below on cold load, tab switches, refresh and mutations,
zero denied reads and constant requests as row/node count grows. Fixtures cover loading, empty,
filtered empty, local error/retry, restricted, not found, read-only, stale-response races and every
domain state listed below; test zero versus unavailable/suppressed where applicable. Add meaningful
round-trip preservation tests for advanced and unknown fields, and regressions for every inventory
row. Integrator supplies both-theme 1440/768/390 screenshots and axe coverage on the shared seeded
stack, plus manual keyboard/focus-return, 200% zoom and screen-reader checks. Meet Wave 5 done
criteria; mock-ups are proposals, not evidence that the implementation passed.
