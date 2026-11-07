# Demo parity · #530

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/demo.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

/demo uses real Root/shell/navigation and the same page components as production, backed by a
bounded projection of deterministic e2e seeded fixtures. Persistent “Simulated demo · sample data”
banner and ordinary shell context mark every page including deep links. A signed-out visitor never
receives a real session and a signed-in visitor never sends demo requests to their active workspace.

## Inventory and destination

| Legacy capability | Real destination / deliberate disposition |
|---|---|
| Overview KPI/activity, sample profiles, journeys/detail, templates/editor, analytics, approvals | Real Home, People, Journeys, Templates, Analytics and Approvals with shared seeded fixtures |
| Channel/MCP setup and command catalogue | Real Settings Providers / Integrations; developer setup help retains real product instructions, no mocked command catalogue |
| Brand context, navigation, mobile nav, deep hash links, toasts, editor lazy chunk, loading/error | Real shell/grouped nav, canonical /demo-relative links, existing page states/toasts/lazy loading; explicit legacy deep-link mapping |
| Legacy live-site demo, ambient event generation and mock copilot execution | Retired per README cut; static fixtures show outcomes; no replacement engine |
| Legacy single-file build:demo entry | Retain command/shareable entry using real shell fixture mode; I owns build-script integration |
| Demo sign-in link / sign-in Try demo | Retain exit to sign in, no simulated session carried into real mode |

## Exact reads and counts

No live server reads or writes. Fixture transport accepts the same named command inputs/outputs
as the real page: use the exact budgets from each owning contract and Phase 24–26, not a second
page implementation. Home/People/Reports keep their existing period and pagination commands; do
not invent a new demo API. I supplies a fixture projection of apps/server/test/e2e/seed.ts with
fixed clock/time zone, no import of DB/server modules into browser. D supplies read-only responses
for the commands exercised by demo destinations and distinct local loading/error/restricted/not-found
fixtures through the existing test transport pattern; no mutable in-browser command engine.
Each unsupported read returns explicit unavailable UI, never a fake success or production fallback.
Mutation UI must be visibly disabled with “Demo only · changes are unavailable”; local view controls
(search/tabs/canvas zoom) still work. Local unsaved authoring can be inspected if already supported,
but Save, Publish, Send test, Run agent, API token/secret/provider operations cannot execute or claim
success. Transport guard blocks all mutations and real network fallback, independently of controls.
Do not persist sample changes or expose real credentials, invites, signed tokens or recipient PII.

## Domain states and decisions

Simulated marker survives navigation, new tab/deep link, modal, empty/error/restricted screen and
390 layout. Fixed fixture dates/zone explicitly captioned, never Updated just now from browser time.
Rich fixtures reconcile totals between Home and reports using the exact existing metric definitions;
no sum of daily unique counts or fabricated healthy zero state. Role fixtures use normal permission
checks, no special UI bypass. Offline mocks use design fixtures, separately labelled; build uses
seed-derived projection. If a screen requires unsupported execution, explain the demo limitation
and retain its real navigation rather than copying a legacy approximation.

1440/768/390 geometry and keyboard behaviour are the actual shell contract, not a new demo sidebar.
Demo banner wraps at 390 without covering primary controls; exit focus returns to sign-in heading.
Legacy /demo hashes map to real sections (overview→Home, profiles→People, email→Templates,
setup→Integrations, journeys/analytics/approvals same family; live→Home plus retirement notice).
Unknown demo URL shows not found within demo context, never navigates into a real workspace.

## Surface-specific tests

Network interception asserts zero production API/mutation calls even with real local workspace
storage present; direct route/deep links/reload/back/forward stay in /demo. All six navigation groups,
keyboard/mobile shell and marker on dialogs/states; fixture metrics reconcile; no DB or token secrets
in browser bundle; no ambient timers/legacy app import at /demo; shared editor dependencies still
work after retirement; single build entry opens real shell; signed-in app does not load demo fixtures.


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
