# Content families · #526

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/content.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

Templates and Assets use thumbnail-led ListPage content (semantic gallery/phone list); Blocks use
a comparison table. Keep one primary action and publication filters, no table/gallery toggle.
Brand is DetailPage with Brand / Subscriber pages outer tabs and preserved artifact sections.

## Inventory and destination

| Current capability | Destination |
|---|---|
| Template create/search/publication filter and artifact lifecycle | Templates tab/list and shared detail host |
| Subject/preheader/purpose/topic, visual/code mode, undo/redo, Liquid warning, insert image/block, text alternative, sample JSON, visual outlines and insert-column controls, UTM source/medium/campaign | Content editor with recipient preview dominant; secondary settings disclosures retain every field |
| HTML/text, desktop/mobile/dark mail preview; unsaved/saved/fallback provenance; send saved test to self | Preview toolbar and Send me a test; test still explicitly saved version, not local draft |
| Blocks create category/name; description/category/fragment; typed parameter key/label/type/max length/default/required and add/remove; preview/Used by | Templates → Blocks; block DetailPage Content / Preview / Used by / Versions / Activity |
| Existing recipes gallery and parameter types/defaults, prerequisites, check, resolved preview, install drafts/result links | Templates → Starters and existing Create flows; reuse RecipesPage embedded, never silently publish |
| Asset query/kind filter, upload/file chooser/drop/multi-file progress/errors; thumbnails/type/dimensions/size | Assets gallery, same accepted formats and limits; visible upload action also keyboard accessible |
| Asset detail public URL, email PNG variant for SVG, name/alt, usage links, deletion/force confirmation | Detail drawer; force delete still explains all referenced usage; no query per thumbnail |
| Brand create neutral fallback, site/address/language/logo picker/alt/height; seven colours, font/custom stack/radius, contrast checks | Brand Content sections; contrast warnings with text and previews |
| Confirm/confirmed/expired/unsubscribe/unsubscribed/back-to-site copy | Brand → Page wording; all copy keys retained, never hard-coded replacement |
| Archive enabled/title/address/description/subscribe link | Brand → Newsletter archive; does not add new archive publication semantics |
| Subscriber page preview kind/width and form selector, live archive/RSS/sitemap explanation, Edit brand, path/security help | Brand → Subscriber pages context plus preview; explain live brand vs unsaved brand |

## Exact reads and counts

Templates L(email_template); Blocks L(email_block); no preview command per thumbnail. Neutral local
thumbnails with names rather than rendering every template. Template detail H + purposes.list +
one templates.preview({artifactId,version}) clean =4. Dirty local preview=0 extra; blocked block
resolution may read one saved templates.preview with explicit fallback label. Width/dark/text switches
reuse result. Image picker assets.list({kind:'image',limit:200}) once; asset selection needs no get if
list contains required URL. Block picker L(email_block); choosing one adds artifacts.get once to
load its parameters; never one per listed block. Insertion preserves existing block tags.
Selected generic template Preview adds templates.check({artifactId,version})=1 for instant checks
plus templates.preview=1 (shared if same version/revision); editor preview alone has no checks.
Explicit Check links adds templates.check({artifactId,version,checkLinks:true})=1, not background URL
checks. Preserve blocking/warning/info findings, locations/fixes, retry and separate link-check error.
Block Preview adds blocks.preview({artifactId,version})=1 saved, 0 dirty with Save draft to render.
Block detail H=2; Used by adds blocks.usage({artifactId})=1, no template lookup per usage row.
Starters recipes.list=1; selected starter recipes.get + recipes.preview =2; check=one recipes.preview;
install=recipes.install mutation, result links from response, not one read per created draft.

Assets assets.list({query?,kind?,limit:200})=1 per committed/debounced filter; say up to 200 shown,
no fabricated total or new pagination. Open assets.get({id})=1 includes usages; rename/alt saves
assets.update, delete assets.delete with existing force semantics; affected list refresh=1.
Uploads use existing assets.upload per file (mutations, not a read budget); no usage reads per tile.
Brand entry artifacts.list({type:'brand',limit:1})=1 then H=2 and hostedPages.preview({page,brand})=1
for selected preview =4 total. Logo picker adds assets.list once. Subscriber pages L(form) +
archive.issues({}) + hostedPages.preview({page,formId?}) = L+2, plus one selected form artifacts.get
only when no matching cached form detail exists for Published vN provenance. Page/form change repeats
preview only (+ selected provenance read when needed); no preview per form. Host and I-owned preview
adapter must share selected form rather than make duplicate calls. Refresh relevant section only.

## Domain states and decisions

Preserve invalid source/JSON, blocked local block rendering, unavailable selected asset/block,
loading editor chunk, upload partial failure, SVG sanitisation/PNG fallback, asset in-use confirmation,
missing brand neutral look, low-contrast warning, absent/unpublished form override, archive disabled,
empty archive, starter missing prerequisites/check failure/installed draft links. No new starter
inventory: redesign shipped recipes and existing new-template starter. R owns recipe e-mail markup;
C owns editor/gallery. Keep unfamiliar technical editing under explicitly advanced controls, with
plain summaries around it. Never remove raw/code editing or sample fields in pursuit of plain copy.
Read artifacts:read; write artifacts:write, lifecycle per shared contract; tests send only permitted
saved version and remain subject to existing server test-send controls.

## Surface-specific tests

Visual↔code round trip preserves Liquid, plain text, samples and tracking parameters; disabled local
block preview cannot masquerade as fresh; all parameter types/defaults and block usage links;
asset usage/force-delete and SVG alternatives; every brand copy/colour/font/archive field retained;
starter prerequisite failure cannot install, install remains drafts; selected-panel call budgets.


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
