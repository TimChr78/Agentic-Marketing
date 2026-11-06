# Shell and navigation · task S

Task: find work, start an existing creation flow and recover old bookmarks. Owned files and
baseline screenshots: [README](README.md). Follow DESIGN v2 geometry and focus contracts.

## Count correction

The wave plan says “19 work destinations plus Settings”, but its named rows sum to
**18 work destinations plus Settings (19 total)**: 3 + 4 + 4 + 3 + 4. This contract follows
every named destination, adding no invented nineteenth work page. Count this table, not
that prose total. Create, Preferences and merged tabs are utilities, not main destinations.

## Canonical destinations

Rows are exact visual order. Icon strings are Lucide export names (16px, stroke 1.75).
Needs retain current nav.ts semantics: any permission listed; `—` means any signed-in member.
Use `workspace.get.you.permissions` / session `can`, never infer access from role names.
Default role visibility from packages/commands/src/principal.ts: owner/admin see every row;
marketer/Builder sees all work destinations, Imports and public Settings, but not admin-only
Settings or Secrets; approver sees People/Consent/Message activity and all artifacts:read
rows, without Imports or creation; viewer sees artifacts:read rows (including Consent’s
Purposes/Topics) but no People, consent summary, Message activity, Imports or creation.
Viewer Settings contains Integrations and approval policy/autonomy read views. These are
examples, not a replacement for can checks.
Empty groups disappear. Item prefix matching must choose the longest path; `/` matches exactly.

| Group (icon) | Label | URL | Icon | Needs |
|---|---|---|---|---|
| Work (BriefcaseBusiness) | Home | `/` | House | — |
| | Approvals | `/approvals` | CheckSquare | artifacts:read |
| | Agents | `/work/agents` | Bot | artifacts:read |
| Marketing (Megaphone) | Campaigns | `/marketing/campaigns` | Target | artifacts:read |
| | Broadcasts | `/marketing/broadcasts` | Send | artifacts:read |
| | Journeys | `/marketing/journeys` | Workflow | artifacts:read |
| | Web experiences | `/marketing/experiences` | PanelsTopLeft | artifacts:read |
| Audience (Users) | People | `/audience/people` | Users | profiles:read |
| | Segments | `/audience/segments` | ListFilter | artifacts:read |
| | Forms | `/audience/forms` | ClipboardList | artifacts:read |
| | Consent | `/audience/consent` | ShieldCheck | profiles:read, artifacts:read |
| Content (Files) | Templates | `/content/templates` | Mail | artifacts:read |
| | Assets | `/content/assets` | Image | artifacts:read |
| | Brand | `/content/brand` | Palette | artifacts:read |
| Insights (ChartNoAxesCombined) | Analytics | `/insights/analytics` | ChartNoAxesCombined | artifacts:read |
| | Message activity | `/insights/messages` | Mails | profiles:read |
| | Deliverability | `/insights/deliverability` | HeartPulse | artifacts:read |
| | Alerts | `/insights/alerts` | Bell | artifacts:read |
| Footer | Settings | `/settings` | Settings | — |

Consent's union preserves Topics/Purposes access for artifacts-only roles; each tab retains its
own gate. People Imports tab still requires profiles:write; a write-only principal may open that
explicit tab without profiles:read, but cannot open People browsing. No other union grants reads.
Approvals badge uses B7 pending `total`, says “pending requests”, never “assigned to you”.

Expanded navigation is 232px; group label is a button with ChevronDown, aria-expanded and
aria-controls; default all open. Save collapsed group keys in localStorage
`am.navGroups.<userId>.<workspaceId>.v1` as a JSON string array; failures fall back to memory.
On navigation expand the active group without rewriting the saved preference. Settings is pinned
at the bottom, not collapsible. Long navigation scrolls between brand switcher and footer.
Desktop collapse uses existing per-person `am.nav.<userId>` preference, 64px rail: brand mark,
New Plus icon, then five group icons in order and Settings at bottom. Each group opens a named
popover of its permitted destinations; active group gets accent-soft, active item gets a check.
Group clicks never navigate to an arbitrary first page. Escape closes and returns focus.

1440: persistent sidebar, 56px topbar, 32px page inset. 768: no rail, single Menu trigger and
280px modal navigation drawer; page inset 24. 390: same drawer, max viewport minus 48; inset 16,
40px targets; topbar has Menu, final breadcrumb, New Plus, Search, Account. Theme remains in
Account on mobile. Search max 280 desktop; no overflow of breadcrumb. Drawer traps focus,
closes on navigation/scrim/Escape and returns focus. Group popovers use menu keyboard behaviour.

## Settings and account

`/settings` replaces to the first permitted secondary item in the following order; fallback
Integrations is available to everyone. Each explicit child keeps its gate (NoAccess on deep link).

| Secondary label | Path | Lucide icon | Needs |
|---|---|---|---|
| Workspace | `/settings/workspace` | Building2 | workspace:admin |
| Providers | `/settings/providers` | Plug | workspace:admin |
| Integrations and API tokens | `/settings/integrations` | Cable | — |
| Secrets | `/settings/secrets` | KeyRound | secrets:read |
| Users and roles | `/settings/users` | UsersRound | workspace:admin |
| Approval policy and agent autonomy | `/settings/approval-policy` | ShieldCheck | artifacts:read |

Last section has Policy and Agent autonomy tabs (`?tab=policy`, default, and `?tab=autonomy`),
reusing existing policy and workspace autonomy controls and their mutation gates. Agents work
list and detail stay in Work. Settings secondary nav is 200px left column +24 gap +760 body
at 1440; native labelled section select above body at 768/390. No Settings children in main nav.
Account order: noninteractive name/e-mail/role; Preferences (Settings2 → `/preferences`);
Theme submenu System/Light/Dark (Monitor/Sun/Moon); separator; Sign out (LogOut, existing flow).
Preferences content and storage remain existing behaviour. Account has no admin-only links.

## Merged homes

Tabs use query key `tab`, no nested competing nav. Default tab omitted; explicit default allowed.
Invalid tab resets to default with an inline “This tab is unavailable” message; forbidden known
 tab shows restricted state without fetching its data. Keep other query parameters.

| Home | Tabs in order and exact nondefault URL | Existing content retained |
|---|---|---|
| People | People; Imports `/audience/people?tab=imports` | Profiles browsing; existing import upload, validation/progress and history, Import people action gated profiles:write. No new import history API. |
| Consent | Consent; Purposes `?tab=purposes`; Topics `?tab=topics` | Consent summary/history profiles:read; existing purposes editor and topics manager artifacts:read, mutations retain current gates. |
| Templates | Templates; Blocks `/content/templates?tab=blocks` | Existing template gallery and block library; block detail `/content/templates/blocks/:id`; editor insert panel keeps blocks. |
| Brand | Brand; Subscriber pages `/content/brand?tab=subscriber-pages` | Existing brand editor; hosted confirmation, expired-link, unsubscribe page settings/preview. Form overrides stay on Forms. |
| Agents | Agents; Library `/work/agents?tab=library` | Existing agent inventory/details; AI prompt list and detail `/work/agents/library/:id`; journey AI steps link here. |
| Analytics | Performance; AI usage `/insights/analytics?tab=ai` | Existing analytics and existing AI usage report, not a new unified metric query. |
| Journey detail | existing Content, Preview, Report, Versions, Activity | Report `/marketing/journeys/:id?tab=report` hosts existing journey stats scoped to id. |

## Redirects (replace history before fetching)

`:id` is carried verbatim after URL decoding/encoding once. Both list and `/:id` rules must be
registered, specific routes before prefixes. Preserve all query values (including version, review
and pagination) and hash; destination's required tab wins over old `tab`. Unknown tails are not
silently discarded: show Not found. Canonical links, recents and artifactPath emit new URLs only.

| Old | New |
|---|---|
| `/demo-signed-in` | `/` |
| `/build/campaigns`, `/build/campaigns/:id` | `/marketing/campaigns`, `/marketing/campaigns/:id` |
| `/build/broadcasts`, `/build/broadcasts/:id` | `/marketing/broadcasts`, `/marketing/broadcasts/:id` |
| `/build/journeys`, `/build/journeys/:id` | `/marketing/journeys`, `/marketing/journeys/:id` |
| `/build/experiences`, `/build/experiences/:id` | `/marketing/experiences`, `/marketing/experiences/:id` |
| `/build/segments`, `/build/segments/:id` | `/audience/segments`, `/audience/segments/:id` |
| `/build/forms`, `/build/forms/:id` | `/audience/forms`, `/audience/forms/:id` |
| `/build/prompts`, `/build/prompts/:id` | `/work/agents?tab=library`, `/work/agents/library/:id` |
| `/build/topics` | `/audience/consent?tab=topics` |
| `/build/recipes` | `/create?tab=starters` |
| `/design/templates`, `/design/templates/:id` | `/content/templates`, `/content/templates/:id` |
| `/design/blocks`, `/design/blocks/:id` | `/content/templates?tab=blocks`, `/content/templates/blocks/:id` |
| `/design/assets` | `/content/assets` |
| `/design/hosted-pages` | `/content/brand?tab=subscriber-pages` |
| `/design/brand` | `/content/brand` |
| `/audience/imports` | `/audience/people?tab=imports` |
| `/settings/agents`, `/settings/agents/:id` | `/work/agents`, `/work/agents/:id` |
| `/settings/purposes` | `/audience/consent?tab=purposes` |
| `/settings/preferences` | `/preferences` |
| `/insights/ai` | `/insights/analytics?tab=ai` |
| `/insights/journeys?journey=:id` | `/marketing/journeys/:id?tab=report` (consume `journey`) |
| `/insights/journeys` without journey | `/marketing/journeys?view=reports` (existing list with “Choose a journey to open its report”; links select Report) |

Example: `/insights/journeys?journey=jrn_42&from=2026-10-01#waiting` →
`/marketing/journeys/jrn_42?from=2026-10-01&tab=report#waiting`.
Empty/invalid journey ID: picker fallback with “Choose a valid journey”; never fetch undefined.
Unmoved URLs remain: `/approvals`, `/approvals/:id`, `/artifacts/:id`, People and person detail,
Consent, the other Insights and Settings children including `/settings/integrations/tokens/:id`.
Generic artifact URLs remain working and use canonical family links. `/` renders Home, no redirect.

## New menu and create seam

Global New is shown only with artifacts:write. Exact order (label / type / icon): Broadcast /
broadcast / Send; Campaign / campaign / Target; Journey / journey / Workflow; Web experience /
experience / PanelsTopLeft; Segment / segment / ListFilter; Signup form / form / ClipboardList;
E-mail template / email_template / Mail; E-mail block / email_block / Blocks; AI prompt / prompt /
FileText. Separator: “From a starter…” / Library → `/create?tab=starters`. All use existing create
flows and artifacts:write, not approval/publish grants. No New brand here (brand switcher retains it),
no new provider, agent, bulk-send or generated-content capability. Hide empty menu entirely.
Creation selection goes to canonical family list with `?create=<type>` (blocks also `tab=blocks`,
prompts `tab=library`). Page opens existing create dialog once and consumes create with replace;
Cancel leaves list. Reload must not duplicate drafts. `/create` is the existing recipe gallery
wrapped as create flow with Blank and Starters tabs. Reader legacy recipe links can browse;
Create drafts remains artifacts:write. Retain recipe selection/query parameters, no auto-install.

## Command palette and recents

Cmd/Ctrl-K or `/` outside editable controls opens SearchPalette. No query: Recents (max 6),
Create actions (same order/gates as New), then Go to pages (18 + Settings, visibility as above),
then Preferences. Search matches names/types/page labels and exact IDs, groups Actions, Pages,
Artifacts; limits 9 create + 1 starter, 8 matching pages, 20 matching artifacts. Existing artifact
search read can be reused; pages/actions work while search loads or fails. No mutation executes
from the palette; create opens a dialog. No matching results: “No matches. Try a name or type.”

S records successful, authorised artifact/agent/person detail visits regardless of entry point,
and only after data has loaded. Exclude list pages, tabs, search queries, approval requests,
failed/deleted/forbidden loads and creation dialogs. Store max 20 MRU unique `{kind,id}` entries
(no names, e-mails, content or query/hash), localStorage `am.recents.<userId>.<workspaceId>.v1`.
Resolve labels from currently permitted existing reads, never profiles.get per recent person;
show “Person” + Identifier if no name already authorised/loaded. Deduplicate by kind/id,
move visit to front; display at most 6 resolvable entries, omit inaccessible/deleted entries.
No unbounded reads merely to hydrate recents; unresolved entries stay hidden. Clear recents
button removes this key. Storage unavailable → session memory; workspace/user switch isolates
entries, sign-out clears session memory. No analytics events or server history.

Palette is a labelled modal combobox/listbox, 600px max width, scroll body, arrow keys/Enter,
Escape restores trigger. Mobile 16px margins, input 16px, results 40px minimum. New/account
menus use roving focus; no two overlays open concurrently. Mock plates show overlays separately.
