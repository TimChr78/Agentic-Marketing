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

## Interfaces the tasks share

These are the concrete seams the build agrees on; the contracts above stay authoritative.

**List and detail template slots.** `features/artifacts/ArtifactListPage.tsx` keeps the Phase
24–26 page when its optional `template` prop is omitted. A family that opts in supplies
`mobileRow(a)` (a semantic summary with every desktop field and action), optional extra `filters`,
optional `pagination` and an optional `countLabel`; search, publication state, totals, the create
dialog and loading/error/empty states remain the host's. `ArtifactDetailPage.tsx` keeps its
existing `detail` config and `extraTabs`; its exports (`Artifact`, `EditorProps`,
`ArtifactDetailConfig`, `ArtifactDetailView`, `ArtifactDetailActionContext`,
`ArtifactDetailActionSlots`, `ArtifactPendingRead`, `DraftWarning`) stay stable, and no slot may
remove an old tab or action.

**Shared picker index.** `features/artifacts/pickerIndex.ts`, keyed `${workspaceId}:${type}`:

- `readPickerIndex(workspaceId, type, {load?})` reads L(type) through `artifactList.ts`
  (`artifacts.list`, limit 200, sequential cursors, 100-page guard) once and returns
  `{artifacts, total, complete}`. Concurrent selectors share one in-flight read; a failed read is
  not cached, so the next read retries.
- `usePickerIndex(type)` is the page seam and returns `{data, total, complete, loading, error,
  reload}`. It keys on the workspace the API calls use (`setWorkspaceId`), so it needs no extra
  props; `reload()` repeats L(type) and is the only refresh.
- `peekPickerIndex(workspaceId, type)` and `invalidatePickerIndex(workspaceId, type)` cover cached
  inspection and creating an artifact of that type.
- `invalidatePickerArtifact(workspaceId, artifactId)` drops only the loaded indexes in that
  workspace whose rows contain the artifact, i.e. a saved new version refreshes its own lists and
  nothing else. The hosts call it after save, discard and publish; builders must call it after
  their own version-changing mutations. Pickers never call `artifacts.get` per row or per node.
- `ArtifactSelect` already uses `usePickerIndex`; A and J mount their repeated selectors through
  it (or `readPickerIndex` for non-React code) instead of `useAllArtifacts` per picker.

**Demo mode and read transport.** `features/phase27/integration/demo/` holds a bounded plain-data
projection of the e2e seed (`fixtures.ts`: fixed `DEMO_NOW`, UTC workspace zone, MartechSignal,
members, artifact rows, pending reviews), a fixture-backed `CommandTransport` (`transport.ts`) and
a fixture `SessionValue` (`session.ts`). `createDemoTransport()` serves the reads it knows,
refuses every command in `DEMO_MUTATIONS` with “Demo only · changes are unavailable.” and any
other unserved command as explicitly unavailable; it never calls `fetch`, never falls back to the
real API and never writes storage. `installDemoTransport()` installs it behind `api.call`;
`DemoRoot` (`DemoRoot.tsx`) renders the real Root gate and shell over `SessionContext` with the
persistent marker, and sets the demo workspace id in memory only. D replaces `main.tsx`/the
single-file entry with `DemoRoot` and extends the `reads` record with the commands its
destinations exercise; no page branches on demo mode.

**Templates Starters.** `pages/design/TemplatesPage.tsx` has a Starters tab that mounts the
existing `<RecipesPage embedded />`; `/build/recipes` and the “From a starter…” actions point at
`/content/templates?tab=starters`. The `/create` Starters tab remains as it was.

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
