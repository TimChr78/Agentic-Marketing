# Settings and providers · #527

Read [shared interfaces and acceptance](shared.md) and the [source inventory](inventory.md); both
are binding. [Offline mock](mock/settings.html). No production functionality cut except the explicit
legacy demo retirement in the README. No new server commands.

Every canonical Settings destination keeps SettingsLayout secondary navigation and template header,
state and action slots; list sections use ListPage, edit/settings sections DetailPage. No nested
redundant headings. Compact providers into channel rows, with inline status/routing summary and an
Add/Edit drawer. Contextual setup help appears beside the field needing it, not in giant empty cards.
Integrations sections are API tokens, Connect an agent, Event sources, Webhooks/deliveries, Connections;
use a local section selector with deep-link token drawer preserved. Mount selected section only.

## Inventory and destination

| Current page / controls | Destination |
|---|---|
| Settings index first-permitted redirect; six secondary destinations | Same paths/permission fallback; account Preferences stays in account menu |
| Workspace name/time zone, independently saved seed-list addresses/validation (50 max) | Workspace General and Test sends sections, independent save/error states |
| E-mail provider name/adapter/from address/name/reply-to, routing uses, schema config/secrets, enable/edit/delete, webhook URL/rotate, forced tracking warning | Providers → E-mail rows and full drawer; moving a routing use names prior provider |
| SMS name/adapter/sender/uses/price/budget/currency/help/account SID/service SID/base URL/auth token; inbound URL copy, development adapter | Providers → SMS drawer and compact rows; all adapter fields preserved |
| Push adapter/name/enabled/uses; VAPID contact/public key, FCM project/base/token URL/client email/private key/key id, APNs team/key/topic/environment/base/private key | Providers → Push drawer, schema-specific fields and setup instructions; generated VAPID keys unchanged |
| AI name/API style/base/default+fast model/structured outputs/personal-data permission/uses/budget/region/enabled/key | Providers → AI drawer; no new models or provider execution |
| Tokens list/status/scopes/owner/expiry/usage/warnings; create name/brand/scopes/expiry/one-time value; detail rename/scopes/expiry/date/password; revoke | Integrations → API tokens, existing token deep link drawer; scope expansion/expiry extension still needs password, own-token revoke retained |
| MCP URL/copy and agent connection instructions | Connect an agent section, developer-facing technical detail retained |
| Sources browser/server/name/origins/required purpose/enabled/edit/delete/key rotate/once-only key/SDK snippet | Event sources section, same consent and origin rules |
| Webhooks name/URL/events/purpose/enabled/edit/test/delete/signing secret; delivery status/attempts/error/date and retry | Webhooks section with endpoint list and recent delivery list; all errors visible, no silent collapse |
| Connections connector/name/config/secrets/enabled/OAuth state/authorize/edit/delete/inbound URL | Connections section; generated schema fields stay complete; authorization failure has recovery |
| Secrets names/date/actor; add/replace/delete and show only while typing | Secrets ListPage and drawer; no read-back of stored value |
| Users member identity/role/since/change/remove with own/last-owner protections; invitation email/role/link/expiry/revoke; SSO/SCIM read-only summary | Users and roles sections; one-time invitation link is not described as emailed |
| Approval policy choices/current/save; autonomy all action-class ceilings/guardian limits/working controls currently exposed | Approval policy / Agent autonomy tabs; reuse existing AutonomyProvider/controls, no new policy |
| Preferences system/light/dark, account/workspace/role/explained permissions | Account Preferences DetailPage, device-local theme unchanged; human meanings primary, permission codes only in advanced details |

## Exact reads and counts

Workspace and Preferences reuse session workspace/user=0 new reads. Settings redirect=0. Providers:
emailProviders.list + smsProviders.list + pushProviders.list + aiProviders.list =4, shared across rows;
adapter catalogues are existing local registry metadata=0. Drawers=0 reads. Save/toggle/delete refetch
that channel list=1; rotateWebhook returns one-time URL without fetching secret. No provider health
probe per row and no duplicate missing-channel CTA.
Integrations initial API tokens: apiTokens.list + system.inputWarnings =2; token deep link adds
apiTokens.get({id})=1. Create brand selector reuses session memberships=0 reads; creation
uses existing apiForWorkspace target. Connect an agent=0. Event sources sources.list=1; open edit
purpose selector purposes.list=1 shared. Webhooks webhooks.list + deliveries.list({limit:100})=2;
Connections connectors.list + connections.list=2. Switching sections loads just that set once;
refresh repeats only selected set. Current all-sections eager reads become lazy without deleting
controls. Mutations refresh their list(s) only; delivery retry refresh deliveries once; authorization
keeps existing redirect and refreshes connections on return.
Secrets secrets.list=1, editing=0; save/delete refresh=1. Users members.list +
invitations.list({status:'pending'}) + sso.list + scim.status=4; SSO/SCIM error is Unavailable,
not an absent configuration. Role/remove/invite/revoke refresh affected member/invitation list only.
Approval policy uses session=0; autonomy workspace.autonomy=1 shared provider read, not another per
control. Changes workspace.setApprovalPolicy / workspace.setAutonomy preserve existing validation
and response/session refresh behaviour. Every other mutation retains the command named in inventory.

## Domain states and access

Admin-only Workspace, Providers, Users; Secrets secrets:read/write separately; API tokens keep
server owner/admin visibility and own revoke; Sources admin; Webhooks/Connections artifacts:read,
mutation workspace:admin. Approval policy readable with artifacts:read, changes admin; autonomy same
existing controls. Preferences open to all signed-in roles. No hidden denied section fetches.
Show no provider/configured unused/disabled/routing conflict/forced tracking, credential replacement
blank-keeps-existing, invalid schema, one-time secret dismissed, revoked/expired/expiring token,
password-required/rejected, pending/expired invitation, last-owner/self restriction, SSO/SCIM unavailable,
connection pending/error/connected, delivery retry failed/queued. Restrict help to existing setup,
not fictitious verification badges. Budgets are configurations, not historic spend charts.

## Surface-specific tests

All provider adapters and dynamically generated config/secret fields round-trip; no secret read-back;
routing transfer warning; own/last-owner guards; invitation once-only link and not-email wording;
token scope/expiry password checks and cross-brand target; browser-source origins/consent; webhook
retry/test/signing secret; OAuth failure recovery; lazy sections preserve token deep links; autonomy
regression suite and device theme isolation. Assert secret values never appear in logging snapshots.


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
