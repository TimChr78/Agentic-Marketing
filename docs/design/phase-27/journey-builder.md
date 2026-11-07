# Journey builder polish · #528

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/journey-builder.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

Keep JourneyPage's existing host and Report tab, campaign membership link and autosave semantics.
A calmer palette groups existing steps, uses icon/name/short purpose and local search. Add Auto-layout
as an explicit undoable view action. Validation is visible on affected nodes with text and a count;
Check panel remains the complete linked list, including graph-level issues without a node.

## Inventory and destination

| Current capability | Destination |
|---|---|
| All 17 kinds: trigger, e-mail, SMS, push, wait, wait event, wait until, branch, split, goal, AI decision/content, webhook, action, update profile, transform, exit | Palette retains seven existing categories; search never changes available semantics |
| Add/drag/select/move/connect/disconnect/delete connection, node context menu/edit/duplicate/delete | Canvas and keyboard-operable inspector actions; trigger duplication stays disabled |
| Undo/redo/delete selection/fit/minimap/fullscreen/palette/inspector toggles, keyboard shortcuts | Single toolbar with labelled overflow for secondary view controls; 390 summary retains all actions |
| Journey purpose/goal/control enabled/share/min sample/new scope setting | Journey inspector, unchanged validation/defaults |
| Trigger event/segment/reentry/dedup entry key; send template; wait duration/event/timeout/recheck/condition; branch/split weights/outcomes | Selected Step inspector, every existing field and condition editor retained |
| AI prompt/options/fallback/timeout; webhook endpoint/payload; connection/action/input; profile trait/value; transform variable/expression; every next-step outcome | Selected Step inspector; advanced technical fields remain, no reduced node form |
| Validation complete list with links, simulation events/timing/branch answers/AI answers/entry-key sample/event JSON/results/path/outcome/goal | Check and Simulate panels, same saved-version simulation and no sending/model calls |
| Reached/waiting counts and labels, report graph and tables | Existing Phase 26 counts/report untouched; missing counts unavailable, not zero |
| Autosave dirty/saving/conflict/errors, JSON fallback/preview/versions/activity/approval, campaign membership | Shared host retained; integration owner wires template slots once |

## Exact reads and counts

Shared H=2, campaigns.of({artifactId})=1, journeys.stats({artifactId})=1 only when published =4
published /3 unpublished. Journey settings purposes.list=1 on mount. Inspector's shared picker
indexes L(segment), L(email_template), L(sms_template), L(push_template), L(prompt) load only when
that kind's control is opened; a type loads once per workspace even with 100 nodes. Event-trigger inspector adds artifacts.list({type:'tracking_plan',limit:1})=1 and, if found,
one artifacts.get for that plan; cache singleton across trigger selection so stable-key suggestions
are preserved without per-node reads. Segment triggers skip both. Endpoint inspector
webhooks.list=1; action connections.list=1; repeated selections reuse results. No node resolves its
name with artifacts.get. Stats are one result passed to all nodes and shared with report when the
parameters match, never an additional per-node or canvas-count fetch. Report tab exact Phase 26
budget is unchanged and runs only when selected. Simulation journeys.simulate({artifactId,version,
events,branches,ai,sampleEvent?})=1 per Run after saved version; no simulation read on palette edits.
Auto-layout/local validation/search/move/zoom=0 commands. Autosave is existing artifacts.updateDraft
mutation; no auto-publish, new lifecycle control or server layout endpoint.

## Domain states and decisions

Empty canvas offers Start with a trigger; invalid/disconnected/cyclic/unknown step graph remains
editable, issues link to nodes. Unknown config preserved, not coerced into defaults. Auto-layout
uses existing layout helper, changes presentation positions only, preserves ids/config/edges/order
and all branches/control semantics; one undo restores positions, selection and viewport remain usable.
Read-only may fit/inspect/simulate if existing permissions allow but cannot save positions or mutate.
On 390 the useful default is ordered step summary plus issue list and inspector; canvas is an
explicit named scroll region, not unreadably shrunken. At 768 palette/inspector are drawers; 1440
palette / canvas / inspector. Node Tab, Enter select, Delete, Shift-F10, Ctrl-Z/Shift-Z, fullscreen F
and Escape preserved, never intercept while typing. Issue selection focuses node and corresponding
field. Validation is not approval and cannot claim server readiness; server warnings remain authoritative.

## Surface-specific tests

Every kind/field/port survives edit/save; auto-layout preserves graph semantic JSON and is undoable;
cyclic/disconnected layouts terminate; no count request per node; graph-level vs node errors; keyboard
connections and context menu; simulation duplicate entry/waiting/exited/completed/goal paths and
invalid sample JSON; report requests not doubled; no live execution from simulations.


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
