# Recipient surfaces · #529

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/recipients.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

Brand-led reading surfaces: one clear heading, explanation, primary action and quiet way back.
Use brand typography/colours/logo/copy and contrast guidance, never force admin accent onto a brand.
The mock surrounds recipient previews with the real navigation for design review only. Public
pages have no workspace navigation, account controls or simulated admin toolbar.

## Inventory and destination

| Current recipient capability | Destination |
|---|---|
| Form rendered fields/mandatory email/traits/consent text/purposes/double opt-in/confirmation template, redirects/origin/Turnstile | Existing embedded form + POST submission, spacing/labels/focus polished, no new public GET signup route |
| Confirm, confirmed, expired, unsubscribe, unsubscribed with all brand copy and back link; per-form override and fallback origin | Branded reading card, same actions/copy keys and server resolution |
| Preference purpose headings/topic choices and purpose-level unsubscribe, saved notice; manage link after unsubscribe | Branded preferences form with grouped labelled choices, Save preferences, same global and topic semantics |
| Topic unsubscribe confirmation/result and RFC8058 one-click | Existing topic route and action; one-click endpoint still machine-facing, never gated behind a new screen |
| Signed web version, public index/issue pagination/title/date/description/subscribe link | Archive reading layout, same issue links/navigation and safe depersonalized public content |
| RSS, sitemap, canonical/OG/JSON-LD/noindex metadata, live sent archive opt-in | Retained outputs/metadata; no tracking in public archive render |
| Shipped recipes' newsletter, confirmation and automated e-mail markup; subject/preheader/Liquid/body/unsubscribe/preferences/web links and text alternative | Same starter content/parameters, renewed hierarchy/spacing/responsive markup; existing artifacts never rewritten |

## Exact reads and counts

Public routes are server-rendered, **zero admin command calls**; no per-field or per-issue client
fetches. Preserve existing handlers: OPTIONS/POST /f/:id, GET/POST /f/confirm/:token;
GET/POST /u/:token, GET/POST /u/p/:token and /u/t/:token; signed web version /n/w/:token;
GET /n/:slug (canonical redirect), /n/:slug/, /n/:slug/:issue, /n/:slug/feed.xml,
/n/:slug/sitemap.xml. Verify exact current routing before touching presentation; do not relocate
handlers to add a new path. Public page navigation is one document request, POST one existing
submission plus existing redirect response. Forms only have POST, not GET. No API execution in
an offline mock. Admin previews use hostedPages.preview once per selected kind/brand/form as
specified in Content; preview buttons disabled, sandbox unchanged. No analytics/consent-summary or
profile lookup on any public page. Render archive rows from the existing bounded server query,
not a new per-issue template resolution query; no new client read or server aggregate is needed.

## Domain states, public security and access

Public access is capability-token/published-host based, not workspace role. Preserve published form
and host/tenant matching; invalid/missing/expired/used token, unavailable form, disabled archive,
unknown issue, body-too-large, invalid choice, Turnstile failure, already confirmed/unsubscribed,
empty archive, no preference choices, saved preference notice and transient submission failure.
No existence/PII oracle in error copy. GET never confirms/unsubscribes; a visible POST button does.
Preserve scanners and idempotency protections and RFC8058. POST targets and redirect allowlists,
signatures, token scoping, no-referrer/no-store/frame restrictions and existing CSP/nonce stay
unchanged; hosted pages currently disallow scripts through default-src 'none', so never add a nonce-less or third-party
script to style them. OAuth pages' nonce system is outside this redesign and remains intact.
No PII in URLs, hidden analytics, pixels, click rewriting, consent pre-checking or tracking without
consent. Never include token-bearing links in mock fixtures or rendered review diagnostics.
Public archive and web versions retain existing personalized/depersonalized distinction and
sanitisation, not raw template HTML injection. Keep safe text escaping and URL validation.

Hosted cards max reading width 560–640, mobile 16 px gutters and stacked actions; email 600–640
fluid body, inline compatible markup, live text not text images. Logo alt, headings, lang, labelled
controls/error summary, image alt, visible link text, keyboard submit and native no-script usability.
Brand light/dark in mock are examples; actual published brand palette wins, not admin theme storage.
Do not auto-invert custom brand colours. No charts needed; archive issue list is semantic text.

## Surface-specific tests

Extend hostedPages/hostedPageHeaders tests, public-listener and e2e hosted-pages coverage: malicious
copy/logo/URL injection, brand+form precedence, scanner GET nonmutation, POST confirmation/global+
topic unsubscribe/preferences, cross-host token isolation, invalid/expired/used links, body limits,
no PII URL/query/referrer and no tracking before consent; exact CSP/nonce headers unchanged.
Archive index/detail/page/feed/sitemap/metadata/web-version regression, disabled/private issues,
no tracking markup. Starter rendering retains all Liquid variables/blocks/text/link requirements;
client matrix desktop/mobile, dark mail and images blocked, both-theme axe on recipient forms.


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
