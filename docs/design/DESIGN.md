# Admin UI design · v2 (final)

Wave 5 final, 2026-11-08, issue #555 (Phase 28). This contract started as the Wave 5 target for #436;
the 0.14.0 release head implements it. [Showcase](showcase/index.html) is the implementation reference;
[decisions](DECISIONS.md) record alternatives. This text is final for Wave 5: a later wave changes a
binding rule only through a new decision record, not by editing this file's history.

Retained component, theme and accessibility contracts are included below with the v2 rules. The three
contracts below are binding, and are stated here only as the rules a reviewer needs; read
[microcopy](phase-28/microcopy.md), [motion](phase-28/motion.md) and
[skeletons and budgets](phase-28/skeletons-and-budgets.md) for the full text.

## Direction

Calm, precise marketing operations, informed by Linear, Stripe Dashboard and Postmark. Warmer stone
neutrals, generous headings, teal data marks and prominent recipient previews supply warmth and visual
interest. No decorative gradients, glass, mascots, emoji icons or AI sparkles. Product-shaped onboarding
diagrams are allowed. Blue remains the only interaction accent; tenant colours belong inside recipient
content. Agent identity is a bot icon plus “Agent”, never an amber status.

State and consequence come first: what is happening, the result, the next step, then configuration.
Every metric names period, denominator and freshness. No data never means healthy. Tables support
comparison; templates/assets use thumbnails. Do not add a table/cards toggle. Plain object names replace
API keys and identifiers. Use sentence case, specific errors and actions, system fonts only. Lucide icons:
16 px, stroke 1.75; inline 14 px; decorative icons aria-hidden; icon buttons named with tooltips.

## Copy, motion and loading rules

These are the binding rules from the Phase 28 contracts, kept short here; the linked contract is the
authority and the rendered-DOM lint enforces the copy rules in CI.

**Copy.** Calm, direct, specific; sentence case for headings, tabs, buttons and statuses. Name the
object and the consequence, then the next step. Use “e-mail”, “sign in” (verb) and “sign-in”
(adjective); “Agent” is an identity, never a status. One binding verb per action type (New broadcast →
Create broadcast; Save changes; Submit for review; Pause agent; Revoke token). Empty states say what
is absent, its scope and the next existing action; errors say the failed object, the known effect and
the recovery; loading says present participle + object (“Loading performance”). No “Oops”, “Something
went wrong”, “successfully”, generic “Error” or unqualified safety claims. Friendly names replace raw
purpose, metric and prefixed ids in ordinary text; identifiers stay in the copy control and technical
code views. Dates use the workspace zone and locale; counts use locale grouping, and rates keep their
denominator. Full text: [microcopy](phase-28/microcopy.md).

**Motion.** Only orientation or feedback, never content. `--duration-fast` 120 ms for hover/press/focus
and disclosure, `--duration-enter` 180 ms for drawer/menu/toast enter and exit; easing `--ease` and
`--ease-feedback`. Menu/toast travel ≤8 px, drawer ≤16 px; explicit properties only, never
`transition: all`. No animation on charts, counters, skeletons, progress icons, canvas fit, page
content or recipient text. Under `prefers-reduced-motion: reduce` durations and delays become 0,
entrances lose their transform, scroll behaviour is `auto`, and third-party JS motion (React Flow,
GrapesJS) is switched off too. Full text: [motion](phase-28/motion.md).

**Reserved loading and budgets.** Loading reserves the final geometry immediately with static tonal
shapes; shapes appear after 150 ms only if the read is still pending, and a fast read never flashes
them. One labelled `role="status"` region carries `aria-busy`; bars are `aria-hidden`. No spinner,
shimmer or fake percentage. Refreshes keep valid values. Route budgets are decimal gzip kB for JS and
CSS, with separate initial, route lazy and cold ceilings plus independent caps for the chart and visual
e-mail stacks. Full table, geometries and accounting rules: [skeletons and
budgets](phase-28/skeletons-and-budgets.md).

## Colour tokens

Properties are on `:root`, overridden by `[data-theme="dark"]`; future Tailwind aliases use the existing
names. Opaque six-digit sRGB values only. `tokens.json` in the showcase is a machine-readable copy.
Decorative dividers do not need 3:1; `--control` defines all actionable control boundaries.

| Token | Light | Dark | Purpose |
|---|---|---|---|
| `--bg` | `#f7f6f2` | `#111512` | Page canvas |
| `--surface` | `#ffffff` | `#191f1b` | Primary content, input, overlay |
| `--surface-2` | `#f0efeb` | `#222a24` | Table header, hover, inset |
| `--surface-3` | `#e6e5df` | `#2c352e` | Pressed, selected neutral |
| `--line` | `#deded7` | `#343e36` | Outer structure and separators |
| `--line-strong` | `#c5c6bf` | `#49554b` | Emphasised separator |
| `--control` | `#7c807a` | `#87958a` | Interactive boundary ≥3:1 |
| `--fg` | `#202521` | `#edf0e9` | Primary text |
| `--fg-2` | `#4c554e` | `#c0c9bf` | Secondary text |
| `--muted` | `#606860` | `#a0aca1` | Meta and placeholder text |
| `--accent` | `#2457d6` | `#8baafa` | Primary action, link, selection, focus |
| `--accent-hover` | `#1e4bbb` | `#a5bdfb` | Primary hover |
| `--accent-fg` | `#ffffff` | `#111512` | Text on accent |
| `--accent-soft` | `#eaf0fd` | `#222f4a` | Selected navigation and info |
| `--good` | `#18794a` | `#70d29b` | Success text |
| `--good-soft` | `#e7f4ed` | `#193526` | Success fill |
| `--warn` | `#9a5400` | `#f0b665` | Attention text |
| `--warn-soft` | `#fcf0df` | `#392c18` | Attention fill |
| `--bad` | `#c0282d` | `#ff9292` | Failure/destructive text |
| `--bad-soft` | `#fcebeb` | `#422427` | Failure fill |

Neutral layers are warm, low-chroma stone/green, not tenant branding. In dark mode use tonal fills to
separate content: canvas → surface → inset/hover → pressed. No nested card outlines. A table, context
panel or preview frame may have one outer `--line`; internal sections use spacing and horizontal rules.
Buttons: secondary `surface/control/fg`, hover `surface-2`; ghost transparent/fg-2, hover surface-2;
danger `surface/bad/bad`, hover bad-soft, solid bad/accent-fg only in destructive confirmation. Disabled
controls use surface-2/muted/control with no opacity reduction, no hover, and a visible reason. Pressed
secondary = surface-3; pressed primary = accent-hover; selected = accent-soft/accent. Invalid = bad border
and text error plus icon. Focus = 2 px accent outline, 2 px offset, never a translucent ring alone.

Journey category tokens remain the v1 values in index.css (Trigger teal, Message blue, Wait slate,
Logic ochre, AI violet, Action rose, Exit neutral), always icon + label + legend. They describe node
kinds, not chart series or agent identity. Legacy `agent` and `shop-*` tokens must not enter new chrome.

## Typography and geometry

System sans stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
sans-serif`. Mono: `ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace`.
Use tabular numerals for every metric/table number; right-align numeric columns. No uppercase headings.
Page/KPI tracking −0.02em; all other text 0. One h1 per application page.

| Token | Size / line height px | Weight | Rule |
|---|---|---|---|
| `--text-page` | 24 / 32 | 600 | Same at all viewports; wrap long names |
| `--text-title` | 16 / 24 | 600 | Section/drawer title |
| `--text-display` | 32 / 40 | 600 | KPI at ≥768; 28 / 36 below 768 |
| `--text-body` | 14 / 22 | 400 | Descriptions, preview labels, prose |
| `--text-ui` | 13 / 20 | 400; controls 500 | Navigation, buttons, inputs |
| `--text-table` | 13 / 20 | 400; headers 500 | Tables |
| `--text-sm` | 12 / 18 | 400 | Meta, units, hints, freshness |
| `--text-xs` | 11 / 16 | 500 | Noninteractive pill, badge, kbd |

Corresponding line-height tokens are `--text-<role>--line-height`; weight tokens are
`--weight-normal:400`, `--weight-medium:500`, `--weight-semibold:600`. Text input font becomes 16/24
below 768 px to avoid iOS focus zoom; labels/buttons remain 13/20.

Spacing tokens `--space-N: Npx` for N = 2,4,6,8,12,16,20,24,32,40,48,64. No other spacing increments.
Page inset 32 at ≥1024, 24 at 768–1023, 16 below 768. Section gap 32 desktop, 24 below 1024;
section title → body 16; title → description 4; field → field 16; label → control 4; hint/error gap 4.
Card padding 20 desktop, 16 below 768. KPI padding 20 everywhere; grid gaps 16 desktop, 12 mobile.

Radii: `--radius-sm:4px` only checkbox/kbd/code; `--radius:8px` controls/menus; `--radius-lg:12px`
cards/preview/panels; `--radius-xl:12px` dialogs; `--radius-pill:999px` status/count. Never pill buttons.

| Elevation token | Light | Dark | Permitted use |
|---|---|---|---|
| `--shadow-1` | `0 1px 2px rgb(0 0 0 / .06), 0 4px 16px rgb(0 0 0 / .08)` | `0 1px 2px rgb(0 0 0 / .4), 0 6px 20px rgb(0 0 0 / .35)` | Menu, popover, tooltip, toast; recipient preview separation |
| `--shadow-2` | `0 12px 40px rgb(0 0 0 / .18)` | `0 16px 48px rgb(0 0 0 / .55)` | Drawer, modal |
| `--scrim` | `rgb(10 12 16 / .45)` | `rgb(0 0 0 / .6)` | Modal/drawer backdrop |

All ordinary cards, KPIs, tables, navigation, sticky bars and segmented controls have **no shadow**.
Overlay retains a 1 px line. Z levels: normal 0, sticky 10, drawer 40, modal 50, toast 60, menu/tooltip 70.
Motion: `--duration-fast:120ms` ease-out hover/press; `--duration-enter:180ms`,
`--ease:cubic-bezier(.2,.8,.2,1)` opacity + translate (drawer 16px X; menu/toast 8px Y).
Chart animation off; no animated number counting, shimmer or looping progress. Loading uses static
tonal shapes and a static progress icon with the object-specific label.
Reduced motion: all durations and delays 0, entrances un-transformed, scroll `auto`; the static
skeleton and progress text remain, because they carry the status.

| Control | ≥768 px | <768 px |
|---|---|---|
| Button/Input/Select | md 32 high, 12 horizontal padding; sm 28 high, 10 padding | Both 40 high, 12 padding; input font 16 |
| Icon button / copy / close | md 32 square; sm 28 square | 40 square |
| Tabs / menu / nav row | 36 / 32 / 32 high | All at least 40 high |
| Checkbox / switch | 16 square / 28×16 visible inside 32-high label | 20 square / 32×20 inside 40-high label |
| Textarea | min-height 96; padding 10×12 | min-height 120; padding 8×12 |

Interactive targets must be ≥40×40 below 768, including pagination, inline copy, chart table toggles,
editor handles and pill filters; 8px gap between adjacent controls. Noninteractive pills stay 20 high.
Do not increase density by shrinking touch hitboxes. Pointer-coarse at wider widths also uses touch sizes.

## Data visualisation

Categorical colours are deliberately separate from state colours. Assign stable series order, never
reassign a colour on filtering. Maximum six series, maximum three in one line plot; use small multiples
beyond three. Direct labels use fg, not series colour. Every series has the encoding below; labels,
marks and a table make the palette safe when colours converge in colour-vision deficiency simulation.
No six-colour set is guaranteed separable by hue alone under all deficiencies.

| Token | Name | Light | Dark | Line dash / marker |
|---|---|---|---|---|
| `--viz-1` | Blue | `#2457a7` | `#8eb5ff` | solid / circle |
| `--viz-2` | Teal | `#087d80` | `#59c8c6` | 6 3 / square |
| `--viz-3` | Ochre | `#996000` | `#e8b653` | 2 3 / triangle |
| `--viz-4` | Violet | `#8256a8` | `#c3a1e5` | 8 3 2 3 / diamond |
| `--viz-5` | Terracotta | `#ba472b` | `#ff9d80` | 10 4 / cross |
| `--viz-6` | Slate | `#59636e` | `#b6c1cc` | 1 3 / plus |

| Ramp (tokens in index order) | Light | Dark |
|---|---|---|
| Sequential `--seq-1` … `--seq-5` | `#e2f3f1`, `#acd9d6`, `#6bb8b4`, `#268e8e`, `#09666c` | `#213c3c`, `#2b5e5d`, `#378782`, `#55b2aa`, `#8cddd0` |
| Diverging `--div-1` … `--div-7` | `#9a4c0c`, `#cb8b48`, `#f0d0aa`, `#f0efeb`, `#b6d9d7`, `#5faaa9`, `#086f73` | `#f5c48a`, `#ce985e`, `#7c5a35`, `#2c352e`, `#305c5a`, `#52a09a`, `#8cddd0` |

Sequential = five labelled ordered bins, low → high, monotonic luminance (dark → light in dark theme).
Diverging = terracotta negative, neutral zero (bin 4), teal positive; symmetric numeric bins, monotonic
luminance per arm. Use only for quantities with a meaningful zero, never good/bad classification. Put a
1px fg-2 boundary on ramp cells because pale bins are below 3:1; include numeric labels outside cells.
Charts use surface background only. Categorical strokes and bars ≥3:1 against surface; text ≥4.5:1.

Measured contrast (light / dark): fg on surface **15.58 / 14.56**, muted on the selected neutral
fill **4.56 / 5.38**, primary button text **6.16 / 8.10**; categorical marks on surface
**4.93–7.01 / 7.62–9.17**. Full pair-by-pair values are in the report.

Verification: `python3 docs/design/showcase/verify_palette.py` reads tokens.json, verifies the HTML
properties match, emits [contrast and CVD report](showcase/contrast-report.md), and exits nonzero on
failure. It checks WCAG sRGB contrast, normal text on all neutral fills, status on soft fills, control
boundaries, all six marks on surface, ramp luminance order, and full-severity protanopia/deuteranopia/
tritanopia using Machado 2009 linear-sRGB matrices. Pair distances are diagnostic, not a WCAG
colour-blindness threshold: convergent pairs require the specified unique dash/marker and direct label.
This numerical check does not replace human review with assistive technology.

### Chart contract

- Heading states one question, e.g. “How many readers clicked each issue?” Subtitle names measure,
  period, time zone and denominator. Counts and rates use separate charts, never a dual axis.
- Wrapper remains lazy ECharts, SVG renderer, ResizeObserver and theme re-read; replace hard-coded
  IBM Plex with system font. Read viz/seq/div plus fg/fg-2/muted/line/surface/control tokens, remove
  legacy agent colour. Shared primitives own formatting/state/table, callers supply labelled data.
- Chart block has title 16/24, subtitle 12/18, 16 gap to plot; plot height 240 desktop, 200 mobile.
  Plot insets left 48, top 16, bottom 32, right 112 for end labels (mobile right 88); min plot width 160.
  At 390, shorten dates to “9 Oct”, end labels can wrap to two 12/18 lines; never shrink text to fit.
- Lines 2px, markers 6px on hover/end and always at sparse observations; no smoothing; gaps stay gaps.
  Optional area is series colour at .08 opacity with same visible stroke. Comparison period is dashed,
  explicitly labelled “Previous period”. End labels 12/18 fg, 8px offset; maintain 18px vertical separation
  with 1px leader lines. If impossible, split into small multiples. No detached colour-only legend.
- Horizontal bar default: 20px bars, minimum 12px gaps, category label above at mobile; values at end
  with 8px gap. Zero baseline always; sort descending except inherently ordered categories. Negative
  values use signed axis. Maximum eight categories; show “Other” only when aggregation is valid.
- At most four horizontal gridlines, 1px line, no vertical grid, no bounding axis box. Labels muted
  12/18. Counts use integer ticks, rates percent ticks; bars start at zero; line baseline zero unless
  a clearly labelled bounded rate range is necessary. No hidden scale truncation or 3D/pie decoration.
- Tooltip surface, line border, radius 8, shadow-1, padding 12, max-width 280: date + zone, series label,
  exact value/unit, denominator and comparison. Never hover-only information. Escape dismisses; keyboard
  arrows explore points with a visible focus indicator; touch tap pins and a 40px close dismisses.
- “Show data table” follows every chart, keyboard operable, same values/units/period/state; native
  caption, column headers, tabular numbers. SVG has title/description; summary sentence outside it.
  Do not announce every mouse move; keyboard point announcements polite. No-data has no fake axis.

| Data state | Plot / KPI | Copy / next step |
|---|---|---|
| Empty configuration | No axis or value | “Choose a measure to see a trend.” Choose measure action |
| No data | No line; value em dash | “No sends in this period.” Change period; never 0% healthy |
| Zero observed | True zero and baseline mark | “0 clicks · 1,240 delivered”; only with valid denominator |
| Below evaluation volume | Count allowed; rate em dash; no sparkline | “Below evaluation volume · 38 / 100 required”; threshold from existing evaluation, never invented |
| Suppressed | Em dash, no marks or derived delta | “Suppressed · fewer than 5 people”; do not leak count in tooltip/table/export |
| Loading | Same-height skeleton, aria-busy | “Loading performance”; no stale zero; preserve block dimensions |
| Error | No fabricated values | “Performance unavailable. Retry.” Inline error and Retry |
| Stale | Last known values permitted, muted delta | “Updated 4 h ago · stale”; freshness threshold supplied by existing source |
| Paused | Last valid values, neutral Paused pill | “Collection paused”; timestamp and resume link if authorised |

### KPI tile

Contract fields: label, value|null, unit (`count`, `%`, currency or duration), numerator/denominator for
rates, period start/end + zone, comparison period + previous value, favourable direction (`up`, `down`,
`neutral`), sparkline points, updatedAt|null, staleAfter from source, dataState and explanation/action.
No new persistence or thresholds. Missing metadata is “Not available”, never 1970.

Min width 208 desktop; one column mobile (358 usable at 390). Padding 20, radius 12, surface, no shadow;
outer grid may have separators, never a border per nested subpart. Label 13/20 fg-2, gap 8, value 32/40
(28/36 mobile); unit 14/22 fg-2 baseline aligned with gap 4. Delta row after 8: 12/18 + direction arrow
and words (“↑ 12.4% more”, good only if up is favourable; “↑ 0.2 pp higher”, bad if bounce rate).
Percentage rates compare in percentage points; counts use relative percent; previous zero → “No
comparable baseline”; no infinity. Neutral delta uses fg-2; equality “No change”. Delta is never inferred
healthy from sign alone. Sparkline 96×32 at right of delta row, 2px viz-2, no axes, same period, hidden
from AT (summary/table carries values). Missing/insufficient data removes delta and sparkline, not height.
Period row 12/18 muted after 12; denominator row 12/18 fg-2 after 4; freshness row 12/18 muted after 4.
Minimum height 204; long explanations grow, equal-height tiles in a row. Freshness always visible.

## Page templates and responsive rules

Widths below are viewport CSS pixels, never device pixels. Shell sidebar 232 expanded / 64 collapsed
at ≥1024; drawer below 1024, **one** menu trigger. Top bar 56 high, 1px bottom line; search max 280 on
desktop, icon below 768. Sidebar row 32 desktop, 40 touch, group gap 20; logo 28×28 object-fit contain,
no clipping/colour strip. Brand name/domain stay visible when expanded.

| Geometry | 1440 | 768 | 390 |
|---|---|---|---|
| Persistent sidebar | 232 | None; 280 drawer | None; min(280, viewport−48) drawer |
| Main x / usable width | 264 / 1144 | 24 / 720 | 16 / 358 |
| Page top (after 56 bar) | 32 | 24 | 24 |
| Section gap | 32 | 24 | 24 |
| KPI columns | 4 × 274 (16 gaps) | 2 × 352 (16 gap) | 1 × 358 (12 gap) |
| Detail content / gap / context | 800 / 24 / 320 | 720 / 0 / below content | 358 / 0 / below content |
| Settings secondary / gap / body | 200 / 24 / 760 (remaining 160 unused) | 720-wide selector / stacked body | 358-wide selector / stacked body |
| Editor settings / gap / preview | 360 / 24 / 760 | 720, one selected pane | 358, one selected pane |

Content cap 1280, centred within shell after page insets; reading width 760 left-aligned within it;
editor/canvas full width. This intentionally replaces ui/layout.ts's current 1600 default cap.
At ≥1280 details use 320 context with minmax(0,1fr) primary; below 1280 stack context after primary.
At 768–1023 page inset 24, at 1024+ 32. At 768 controls still desktop-sized (coarse pointer overrides).
At <768 heading/action stack with 12 gap; title wraps, actions wrap with 8 gap; no fixed header height.

**List:** header title + description left, primary action right; 24 gap to filter row, 16 to table.
Search 280 desktop, state select 160, gap 8, count aligned right. Mobile search full width, next row
state select plus honest count (“3 of 47”, not “47” when only 3 loaded). Desktop column widths for
Broadcasts at 1144: name 400, state 144, audience 180, schedule 232, result 188 (includes padding).
Header 36 high, normal row min 48, name+secondary row 64; cell padding 12×16. Mobile uses a single
semantic list of 72px-min summary rows: name and state, then audience/date; open detail for results.
At 768 table keeps name/state/schedule, audience under name, result under schedule (40/24/36% widths).
Pagination 48 high desktop, min 56 mobile; no page-level horizontal overflow. True wide data tables
may scroll inside a labelled, focusable region; never hide primary actions offscreen.

**Detail:** name, kind + operational pill, primary action; next metadata line contains version, actor,
updated time and Identifier. Consequence summary comes before tabs (padding 16, surface-2, radius 12):
audience count + eligibility, timing with zone, dependencies, next step. Tabs 40 high with bottom line,
24 gap to content. Default family tabs Content, Preview, Versions, Activity; broadcast adds Report
and Sending where supported; journey Report replaces separate stats destination. Context panel shows
owner, segment, schedule, dependencies (padding 20, surface-2, no nested borders). At mobile show
consequence summary above horizontally scrollable tabs; context follows content, critical blockers stay
in summary. Recipient preview is dominant, 640px email max on white, labelled Unsaved draft / Saved v2 /
Published v1, with shadow-1. Its theme never changes when admin theme changes.

**Settings:** one Settings destination; secondary nav exactly Workspace, Providers, Integrations and API
tokens, Secrets, Users and roles, Approval policy and agent autonomy. Preferences in account menu.
Desktop secondary rows min 36, 8 gap; tablet/mobile native section select with visible label before form
(40px on touch). Form max 760, field groups divided by 32/24 vertical spacing; save row 24 after fields.
Avoid giant empty cards per missing provider; one compact setup row per channel.

**Editor:** header → consequence/validation summary → settings/recipient preview; pane divider is line,
not nested cards. At <1024 use 40px Settings / Preview segmented buttons, one visible pane at a time;
preview label includes draft/version. Sticky bottom action bar: surface + top line, no shadow, min-height
64 desktop / 72 mobile plus env(safe-area-inset-bottom), padding 12×24 desktop / 16×16 mobile, 8 gap;
save state left, Save draft secondary + Submit for review primary right. At mobile save state occupies
its own line when needed; bar grows. Content bottom padding equals measured bar height + 24; no hidden
last field. Journey canvas may pan inside a labelled region; use node list/inspector on phones.

### Navigation target

**Built in Phase 24 (#446).** Work: Home, Approvals, Agents. Marketing: Campaigns, Broadcasts, Journeys,
Web experiences. Audience: People, Segments, Forms, Consent. Content: Templates, Assets, Brand.
Insights: Analytics, Message activity, Deliverability, Alerts. Settings: single entry with secondary
navigation above. Paths are the canonical URLs in `apps/web/src/app/nav.ts`; legacy URLs redirect with
their query and hash preserved.
Imports → People action/history; Topics → Consent beside Purposes; Blocks → Templates tab/insert panel;
Hosted pages → Brand → Subscriber pages; Recipes → create gallery; AI prompts → Agents library;
Journey stats → journey Report; AI usage → Analytics view. Old URLs redirect, deep approval links survive.
Role gates below persist; apply them to the destination after moving it.

Brand switcher lists memberships with logo, name and primary domain. “New brand” appears only for a
person who owns at least one brand; keep the existing name/domain/site-name/logo wizard. Product mark
and wordmark follow [brand-assets.md](brand-assets.md), generated from `packages/core/src/brand.ts`;
do not redraw a new mark per surface.

## Identifier

`Identifier({value, label="ID"})`: secondary metadata only; never the primary heading/name. Inline group
with mono 12/18 fg-2 and 6 gap, max-width 100%. If length >16 display first 8 + “…” + last 4 characters;
otherwise full string. Example `brd_01JB…7Q2M`. Full value available in focus/hover tooltip (show after
300ms, Escape closes) and accessible name “Copy ID <full value>”. Copy button 28 square desktop / 40
square touch with 14px copy icon; copies the exact original, not shortened form. On successful clipboard
write announce “ID copied” politely and show check for 1500ms; on failure show “Could not copy ID” and
selectable full value. No success on unsupported clipboard. Touch tap on displayed short ID expands
selectable full text inline (wrap anywhere); copy remains separate. Do not expose secrets via Identifier.

## Operational state pills

20px high, 8px horizontal padding, 6px gap, 6px dot plus text, 11/16 medium, radius-pill; noninteractive.
Use named state text plus icon shape for failure/hold/pause (14px) where shown below. Interactive filters
wrap a 32/40px control; never make a 20px pill the hit target. Operational state is primary; publication
version appears as neutral metadata “Published v2”, never as an execution-success claim.

| Family | State → tone / marker |
|---|---|
| Broadcast | Draft → neutral/dot; In review → warn/clock; Scheduled → info/clock; Sending → info/arrow; Sent → good/check; Paused → neutral/pause; Blocked → bad/octagon |
| Journey | Draft → neutral/dot; Live → good/check; Paused → neutral/pause; Stopped → neutral/square |
| Agent | Active → good/check; Paused → neutral/pause; Held → warn/hand |
| Version only | Draft → neutral; In review → warn; Published → good; Rejected → bad; Superseded/Disabled → neutral |
| Evaluation only | No data → neutral; Below evaluation volume → neutral; Healthy → good; Warning → warn; Paused → neutral; Error → bad |

neutral = fg-2/surface-2, info = accent/accent-soft, good/warn/bad = matching text/soft tokens.
Blocked/held require a nearby reason and permitted next action. Do not map an unknown API state to green:
show neutral “Unknown state” and full raw value only in technical details. UI does not invent execution
semantics or override server-derived state. Healthy requires an actual evaluated sample/threshold.

## Themes

Three choices: **System** (default), **Light**, **Dark**, in the account menu →
Your preferences. The choice is stored per user on this device (`localStorage`, key `am.theme.<userId>`,
with an unscoped fallback for the sign-in page) and applied by an inline script in `index.html` **before
first paint**, so there is no flash. System follows `prefers-color-scheme` live. Embedded previews of
e-mails and hosted pages always render as the recipient will see them (light, their own styles); only the
frame around them follows the theme.

The desktop navigation rail uses the same per-person, per-device store (`am.nav.<userId>`, values
`expanded` and `collapsed`) and is also read by the inline script before first paint. A small `usePref`
helper in `apps/web/src/app/prefs.ts` owns the read, write and subscription, so a third copy of this
logic does not grow. Under 1024 px the mobile drawer does not read the preference.

## Components

Each component lives in `apps/web/src/ui/` and is the only way that pattern is built.

- **Button**: variants `primary` (accent, one per view), `secondary` (bordered), `ghost` (toolbar, icon
  buttons), `danger` (bordered red; filled red only inside a confirm dialog). Sizes `sm` 28 px, `md` 32 px; both become 40 px below 768 px.
  `loading` shows the static progress icon with the object-specific label, keeps the width and blocks a
  duplicate submission; disabled buttons explain why in a tooltip or helper text.
- **IconButton**: square ghost button; `label` is required (used for `aria-label` and tooltip).
- **Input, Textarea, Select, Checkbox, Switch, DateTimeInput**: 32 px (40 px below 768 px), 8 px radius, `--control` border,
  accent border plus focus ring on focus. Always used inside **Field**: a visible label (never a placeholder
  as label), optional helper text, unit suffix (`MB`, `days`, `%`), and an error line. Validation runs on
  blur and on submit, not on every keystroke; server errors (`treeifyError` details) are mapped to the field
  they name. `DateTimeInput` edits in the workspace time zone, shows the zone, and sends ISO 8601 with offset.
- **Table**: header on `--surface-2`, 48 px rows (40 px compact; 72 px mobile summaries), row hover, the whole row is a link when it
  opens a detail page (with a real `<a>` for middle-click), numbers right-aligned and tabular. Loading shows
  skeleton rows; empty shows an **EmptyState** inside the table frame; errors show an inline alert with the
  reason and a Retry button.
- **Card**: surface with `--radius-lg`; only outer structural frames have a border; optional header (title, actions). Used for grouped settings
  and dashboards, not as a substitute for tables.
- **Drawer**: 560px right-side dialog (full width below 640px), `role="dialog"`, `aria-modal`, labelled by its title; focus moves into it,
  is trapped, and returns to the trigger on close; `Esc` closes; header (title, meta, close), scrollable body,
  sticky footer for actions. Deep-linkable where it matters (`/approvals/:id`).
- **Modal / ConfirmDialog**: centred, max 480 px. Destructive confirmations name the object ("Delete provider
  'Brevo marketing'?"), state the consequence, and for irreversible or high-impact actions require typing
  the name. The confirm button says the action ("Delete provider"), never "OK".
- **Toast**: bottom-right (bottom-centre on phones), `aria-live="polite"` (errors `assertive`), auto-dismiss
  after 5 s for success, persistent for errors, with an optional action ("Undo", "Open").
- **EmptyState**: one sentence on what this list holds, one on how to fill it, and the primary action
  (or the command an agent would use, e.g. `templates` via MCP). Small product-shaped onboarding diagrams allowed; no decorative illustrations.
- **StatusPill**: dot + text, tones `neutral`, `info`, `good`, `warn`, `bad`. Standard mappings: draft →
  neutral "Draft"; in review → warn "In review"; published → good "Published"; rejected → bad "Rejected";
  superseded → neutral "Superseded"; disabled → neutral "Disabled".
- **Badge**: small count (navigation, tabs). **Kbd**: keyboard hint.
- **CodeView / JsonView**: mono 12 px on `--surface-2`, line wrapping toggle, copy button; JSON is
  pretty-printed and collapsible by key.
- **DiffView**: per-path list (added / removed / changed) with before and after values, plus a side-by-side
  text diff for long strings (e-mail HTML, text versions). Colour is backed by `+`/`−` markers and labels.
- **Tabs**: WAI-ARIA tabs (arrow keys move, Home/End), URL-synced where they are a page section.
- **Menu**: button + popover list, WAI-ARIA menu button pattern (arrow keys, type-ahead, `Esc`).
- **Skeleton**: static tonal shapes matching the final layout's size, never a shimmer. The region is
  labelled once (`role="status"`, `aria-busy`); the shapes are `aria-hidden`. See the reserved-loading
  rules above and [skeletons and budgets](phase-28/skeletons-and-budgets.md).
- **Preview frames**: sandboxed `<iframe srcdoc>` (no scripts), width presets desktop 640 px (the e-mail's
  own width inside a 1024 frame) and mobile max 375 px, constrained to the available width.

## Accessibility

- Everything works with the keyboard: navigation, tables (rows are links or buttons), menus, drawers, the
  journey canvas (Tab to nodes, arrow keys to move the selection, `Delete`/`Backspace` deletes, `Enter`
  opens the inspector, `⌘Z`/`⌘⇧Z` undo and redo) and the asset picker.
- Visible focus ring on every interactive element: 2 px `--accent` outline, 2 px offset (`:focus-visible`).
- Custom widgets use ARIA: drawers and modals (`dialog`), tabs, menus, the canvas (`role="application"` with
  an `aria-label`, nodes as focusable `group`s with labels such as "E-mail step: Welcome, incomplete"),
  toasts (`status`/`alert`), counters (`aria-label="3 pending approvals"`).
- Hit targets ≥ 24 px (WCAG 2.5.8), ≥ 40 px on touch layouts.
- Colour is never the only signal (status pills have text, diffs have markers, node categories have icons
  and labels).
- `prefers-reduced-motion` is honoured; no autoplaying motion.
- Forms: labels tied to inputs, `aria-describedby` for helper and error text, `aria-invalid` on errors,
  focus moves to the first invalid field on submit.
- Page titles: `<title>` = "Page · Workspace · Agentic Marketing"; one `<h1>` per page; landmark regions
  (`nav`, `main`, `header`).
- Automated: `e2e/axe.spec.ts` runs axe-core with the WCAG 2.1/2.2 A and AA rules over every route in
  the screenshot matrix, in both themes, and fails on any violation that is not listed with a reason
  in `e2e/axe-known-issues.json`. That list is empty at the end of the wave; the manual checks above
  (keyboard, focus return, 200% zoom, a screen reader) still cover what axe cannot.

## Roles and what they see

| Group | Who uses it | Shown when the role has |
| --- | --- | --- |
| Work | Readers and approvers | Home is role-aware; Approvals and Agents need `artifacts:read`; approve/reject need `artifacts:approve` |
| Marketing / Content | Builders | `artifacts:read`; create/edit require `artifacts:write` |
| Audience | Builders | Existing destination gates persist: profiles `profiles:read`, imports `profiles:write`, artifact forms/segments `artifacts:read` |
| Insights | Readers | Preserve each existing route gate: Message activity `profiles:read`; other current reports `artifacts:read` |
| Settings | Per destination | Workspace/Providers/Users need `workspace:admin`; Secrets `secrets:read`; policy reads `artifacts:read`; integrations and own tokens remain account-accessible |

Navigation regrouping changes no authorisation. Use `app/nav.ts` and route/action gates as the authority;
policy/autonomy writes keep their existing checks. An empty group is hidden. Preferences stays available
from the account menu for everyone.

Actions that would fail with 403 are not shown; if showing them helps understanding, they are disabled
with the reason ("Only approvers can approve").
