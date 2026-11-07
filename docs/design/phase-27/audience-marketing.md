# Audience and marketing families · #525

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/audience-marketing.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

Forms, Segments, Web experiences use ListPage and DetailPage; Consent and Alerts use the same
header/state geometry for their summary/list panels. No redundant nested page headings.

## Inventory and destination

| Current capability (source ledger is binding) | Destination after redesign |
|---|---|
| Forms create name + confirmation e-mail, default consent/purposes/traits/redirect | New form dialog, unchanged defaults and validation |
| Form purposes, consent text, double opt-in, confirmation template; trait add/remove and limits | Content → Consent and Fields; unsaved form preview beside them |
| Success/confirmed/error redirects, allowed origins, Turnstile; form-specific site/logo/accent and confirm/expired copy | Content → After submitting, Security and Hosted pages disclosures; all retain values when collapsed |
| Hosted preview and source/version; generic host tabs/actions | Preview with saved/live source; shared host tabs/actions remain |
| Segment dynamic/static/snapshot create and published source | New segment dialog with plain mode explanations |
| Dynamic description, all/any nested groups, trait operators, event count/window, purpose, nested segment, negation, add/remove groups, JSON view and estimate | Content → Who is in it, description, estimate; technical condition view behind Advanced |
| Static/snapshot description, source/version/date, member list/total/paging, add/remove people, CSV column/id-type/file/dry-run/unmatched rows, import history and refresh snapshot | Content → Members; data changes remain immediate, not a new artifact version; membership is not consent |
| Experience placement/priority/description; trigger immediate/exit intent/scroll/time with values; variant add/remove/reorder, identifier/name/relative weights and HTML or JSON content; targeting everyone/segment/custom, holdout/goal/analysis alpha/threshold and advanced content | Content editor plus existing advanced document editor, with every current schema field preserved; do not replace with a reduced bespoke form |
| Results exposures, conversions, rate, lift, interval, significance, P(best), method/control/goal and refresh | Results tab, table first; interval is visible text rather than hover only |
| Consent purpose/basis/channel/choice counts, person email/id lookup, profile link, current choices and append-only ledger | Consent tab, purpose summary then lookup and person panel |
| Record purpose/choice/channel/source/proof note; missing choice distinct from refusal | Record consent drawer, append-only, existing profiles:write gate |
| Purposes artifact create/edit/link, channels/basis/double opt-in/counts | Purposes tab, in-force definitions separate from draft editor; purpose key/name/description/basis/channels/double opt-in; subscriber-topic key/name/description/default add/remove; legitimate-interest assessment text/owner/review date all retained |
| Current Topics editorial queue: owner/tag/status/min-score filters, create title/angle/audience/keyword/date/tags/signals, score/status/brief link, convert to brief/archive | Topics tab with explicit Editorial topics wording; retain current functionality (not topic-preference controls) |
| Alerts rule kind/name/enabled, bounce/complaint window/threshold/minimum, signup drop/window/previous minimum, journey-error window/threshold/journey | List rows with summary; create/edit drawer retains all kind-specific fields; kind fixed after creation |
| Alert channels (webhooks/members), edit/delete/test/history and recent episodes with value/threshold/window/notified outcomes | Row actions and History drawer; explain deletion removes history but queued notifications remain |

## Exact reads and counts

Use shared L/H definitions. Forms list L(form); opening create adds L(email_template) once.
Form detail H + purposes.list=3 plus L(email_template) only if double opt-in picker mounted;
inline form preview is local (0); hosted confirm preview adds hostedPages.preview({page:'confirm',formId})
=1 on opening; share the form host object for provenance, no extra artifacts.get.
Segments list L(segment), reused for snapshot source. Dynamic detail H + one purposes.list and
L(segment) shared across all condition rows. Explicit Estimate uses segments.preview({condition})=1
per request; no estimate on list rows. Static/snapshot H + segments.members({artifactId,limit:50,after?})
+ audiences.imports({segmentId,limit:10})=4. Next members page=1; refresh snapshot/add/import/remove
are mutations, then refetch members/imports only as affected. Preserve dry-run vs applied import.
Segment Preview tab adds segments.preview({artifactId,version})=1 when saved; dirty condition
estimate uses segments.preview({condition})=1, no hidden saved estimate.
Experience list L(experience); detail H=2 (+ L(segment) only when segment targeting opens); selected Results adds experiences.results({artifactId})=1
only when published. Refresh Results=1, never one query per variant. Experience generic Preview is local document display=0 reads; no invented exposure recording.

Consent tab: consent.summary({}) once with profiles:read, purposes.list({}) once with artifacts:read
=2 or permitted subset. Email lookup submit profiles.find({type:'email',value})=1, then profiles.get
and consent.history =2; direct profile id skips find. Purpose names share the first result. Recording
consent refetches selected profile/history and summary (3), not every person. Purposes tab:
purposes.list + artifacts.list({type:'purposes',limit:1}) =2; consent.summary +1 only if permitted.
Opening editor uses H and PurposesEditor's purposes.list, shared with in-force result = no duplicate.
Topics: content.topics.list once per existing filters; create/toBrief/archive keep their current
mutations and refresh list once. No per-topic artifacts.get.

Alerts: alerts.list + webhooks.list + L(journey) + alerts.history({limit:50}) plus members.list
only for workspace:admin =4+L pages for admin, 3+L otherwise. Rule history opens one
alerts.history({ruleId,limit:200}); no calls per rule. Mutation/test refresh alerts.list/history once,
not a cascading repeated history effect. Rule History errors get their own Retry.

## Domain states and decisions

Show published form unavailable/missing confirmation template, invalid trait/origin/URL, pending
confirmation; dynamic estimate unavailable, imported unmatched/duplicate people, static membership
empty, snapshot source missing; experience unpublished, no goal/control, no exposures, null rates,
insufficient significance and fixed-horizon caveat. Results are current aggregate exposure/conversion
counts, not a selected calendar period; show period/freshness unavailable if not returned, never
fabricate a trend or auto-winner. Preserve latest-version analysis semantics and version caption.
Alerts distinguish paused, firing, resolved, not firing and test queued/failed/skipped; existing OK
must not imply healthy traffic when no evaluated volume is available. Keep scheduler cadence wording.
Consent summary needs profiles:read, details same; recording profiles:write, personal identity only
with profiles:pii; definitions/editors artifacts permissions; Alerts mutations workspace:admin.

## Surface-specific tests

Nested/self/missing segment references and unsupported-condition round trip; constant picker calls
with 100 conditions; static CSV dry-run/unmatched/import history; snapshot refresh data semantics;
form custom override preserved while switch off/on, redirect/security limits; experience methods,
visible intervals and no preview exposure; append-only proof/source/channel and redaction; editorial
Topics retained; alert threshold unit conversion and all notification outcomes.


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
