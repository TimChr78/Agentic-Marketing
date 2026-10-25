# Admin UI design

This is the design foundation for the admin UI (`apps/web`) from v0.2.0 on. It covers tokens, components,
layout and accessibility. Decisions behind it, with the options considered, are in [DECISIONS.md](DECISIONS.md).
The tokens live in `apps/web/src/index.css`; the components in `apps/web/src/ui/`.

## Direction

The product is an operations console for marketing work that agents draft and people approve. It should
feel calm and precise, closer to Linear, the Stripe Dashboard or Postmark than to a generic AI app.

- **Information-dense but legible.** Tables over cards where people compare things. 13 px UI text, 14 px
  for reading. Generous line height, few borders, clear alignment.
- **One accent colour, used sparingly:** the primary action on a page, the current navigation item, focus
  rings, links and selection. Nothing decorative.
- **Status colours carry meaning only:** green = live or succeeded, amber = needs attention, red = failed
  or destructive. A status is always text plus colour, never colour alone.
- **No** purple gradients, glassmorphism, emoji icons, decorative illustrations, mascots or "magic"
  sparkles. Agent work is marked with an icon and the word "Agent", not with a colour of its own.
- **Sentence case everywhere**: page titles, buttons, menu items, table headers. "Add provider", not
  "Add Provider".
- **Copy is plain and specific.** Say what happens ("Submits for review; Tim or another approver
  publishes it"), name the object ("Delete 'Welcome e-mail'?"), and give the real reason when
  something fails, with the next step.
- **Icons:** Lucide, 16 px in buttons and navigation, 14 px inline, stroke 1.75. An icon-only button
  always has an accessible name and a tooltip.
- **Fonts:** the system UI stack. The admin UI makes no third-party font requests (privacy, offline
  homelab installs, speed).

## Design tokens

All tokens are CSS custom properties on `:root`, switched by `data-theme` on `<html>`. Tailwind v4 maps
them (`bg-surface`, `text-muted`, `border-line`…) through `@theme inline`.

### Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f7f8fa` | `#0e1013` | App background behind surfaces |
| `--surface` | `#ffffff` | `#15181d` | Cards, tables, drawers, inputs |
| `--surface-2` | `#f2f4f7` | `#1b1f26` | Subtle fills: table header, hover, code |
| `--surface-3` | `#e9ecf1` | `#232831` | Pressed, selected rows |
| `--line` | `#e2e5ea` | `#272b33` | Dividers and card borders (decorative) |
| `--line-strong` | `#c9ced6` | `#3a404b` | Emphasised dividers |
| `--control` | `#868d99` | `#5f6775` | Borders of inputs, checkboxes (≥ 3:1, WCAG 1.4.11) |
| `--fg` | `#14171c` | `#e7e9ed` | Primary text |
| `--fg-2` | `#454c59` | `#b4bac5` | Secondary text, table cells |
| `--muted` | `#646c79` | `#8d95a3` | Meta text, helper text, placeholders |
| `--accent` | `#2457d6` | `#7097f5` | Primary buttons, links, focus, current nav |
| `--accent-hover` | `#1e4bbb` | `#88a9f7` | Hover of accent |
| `--accent-fg` | `#ffffff` | `#0e1013` | Text on accent |
| `--accent-soft` | `#eaf0fd` | `#1a2541` | Selected nav item, info pill background |
| `--good` / `--good-soft` | `#18794a` / `#e7f4ed` | `#4dbd7d` / `#132a1d` | Live, published, delivered, succeeded |
| `--warn` / `--warn-soft` | `#9a5400` / `#fcf0df` | `#e3a24c` / `#2d2211` | In review, not yet viewed, incomplete, warnings |
| `--bad` / `--bad-soft` | `#c0282d` / `#fcebeb` | `#f27474` / `#331718` | Failed, rejected, destructive, errors |

Contrast (WCAG 2.2 AA, checked with a script; ratios on `--surface`): `--fg` 18.0 / 14.6, `--fg-2` 8.6 /
9.1, `--muted` 5.3 / 5.9, `--accent` 6.2 / 6.3, `--good` 5.4 / 7.5, `--warn` 5.8 / 8.1, `--bad` 5.9 / 6.4,
text on accent 6.2 / 6.7, status text on its soft background ≥ 4.8. `--muted` stays ≥ 4.8 on `--surface-2`,
so helper text is AA everywhere. `--control` is ≥ 3:1 against `--surface` in both themes.

**Journey node categories** are the one categorical palette, always shown with an icon and a label and
explained by a legend on the canvas:

| Category | Light | Dark | Kinds |
| --- | --- | --- | --- |
| Trigger | `#0f7a83` | `#41b8c3` | entry, event trigger, segment entry |
| Message | `#3a5bd0` | `#8aa2f2` | e-mail, SMS, push |
| Wait | `#626a77` | `#9aa2b0` | wait, wait until |
| Logic | `#a35f00` | `#e0a24a` | branch, split, goal |
| AI | `#7449c2` | `#a98bef` | AI classify, AI decision |
| Action | `#b0377a` | `#e57ab2` | webhook, connector action, update profile |
| Exit | `#3d434d` | `#c3c8d1` | exit |

### Type

System stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
sans-serif`; mono: `ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace`.
Numbers in tables use `font-variant-numeric: tabular-nums` (`.num`).

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `text-xs` | 11 / 16 | 500 | Pills, keyboard hints, counters |
| `text-sm` | 12 / 16 | 400 | Meta text, helper text, table secondary lines |
| `text-ui` (default) | 13 / 20 | 400, 500 for controls | Tables, inputs, buttons, navigation |
| `text-body` | 14 / 22 | 400 | Reading text: descriptions, notes, previews |
| `text-title` | 15 / 22 | 600 | Card, drawer and section titles |
| `text-page` | 20 / 28 | 600 | Page title (one per page) |
| `text-display` | 24 / 32 | 600 | Key numbers (KPIs) |

### Spacing, radii, elevation, motion

- **Spacing:** 4 px base: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48. Page padding 24 px (16 px under 768 px).
  Control height 32 px (28 px compact in tables and toolbars, 40 px touch targets on phones).
- **Radii:** `--radius-sm` 4 px (pills, checkboxes, code), `--radius` 6 px (buttons, inputs),
  `--radius-lg` 8 px (cards, menus, drawers' inner panels), `--radius-xl` 12 px (modals).
- **Elevation:** surfaces are flat with a 1 px `--line` border. Overlays use shadow:
  `--shadow-1` (menus, popovers, toasts): `0 1px 2px rgb(0 0 0 / .06), 0 4px 16px rgb(0 0 0 / .08)`;
  `--shadow-2` (drawers, modals): `0 12px 40px rgb(0 0 0 / .18)`. Dark theme uses stronger alpha and keeps
  the border, since shadows read poorly on dark backgrounds. The scrim is `rgb(10 12 16 / .45)`.
- **Motion:** 120 ms ease-out for hover and press, 180 ms `cubic-bezier(.2,.8,.2,1)` for drawers, menus and
  toasts (opacity + 8–16 px translate). Nothing loops except loading skeletons (a 1.2 s shimmer) and spinners.
  `prefers-reduced-motion: reduce` turns all transitions into instant changes and stops the shimmer.

## Themes

Three choices: **System** (default), **Light**, **Dark**, in the user menu and in Settings → Workspace →
Your preferences. The choice is stored per user on this device (`localStorage`, key `am.theme.<userId>`,
with an unscoped fallback for the sign-in page) and applied by an inline script in `index.html` **before
first paint**, so there is no flash. System follows `prefers-color-scheme` live. Embedded previews of
e-mails and hosted pages always render as the recipient will see them (light, their own styles); only the
frame around them follows the theme.

## Layout

```
┌────────────┬──────────────────────────────────────────────────────────────┐
│ Workspace ▾│ Breadcrumbs                              Search ⌘K   Theme  │
│            ├──────────────────────────────────────────────────────────────┤
│ Build      │ Page title                                 [Primary action] │
│  Journeys  │ One-line description                                         │
│  …         │ [Filters / tabs]                                             │
│ Design     │ ┌──────────────────────────────────────────────────────────┐ │
│ Audience   │ │ Table or cards                                           │ │
│ Insights   │ └──────────────────────────────────────────────────────────┘ │
│ Approvals 3│                                                              │
│ Settings   │                                                              │
│ (user)     │                                                              │
└────────────┴──────────────────────────────────────────────────────────────┘
```

- **Sidebar** 232 px, collapsible to a drawer under 1024 px (a menu button opens it). Groups: Build, Design,
  Audience, Insights, Approvals (with pending count), Settings. Items a role can't use are hidden; a group
  with no visible items is hidden.
- **Top bar:** breadcrumbs, global search (`/` or `⌘K`/`Ctrl K`), theme toggle, user menu.
- **Page:** title (`text-page`), optional one-line description, **primary action top right**, then filters,
  then the table or cards. Max content width 1280 px; editors (journey canvas, e-mail editor) are full width.
- **Detail pages** share one structure: header with name, type, state pill and the actions the role allows;
  tabs **Content**, **Preview**, **Versions** (history with diff between any two), **Activity** (who changed
  what, from the audit log).
- **Drawers** (right side, 560 px; full screen under 640 px) for review and quick create/edit that keep the
  list in context: approval review, add provider, edit token. **Modals** only for confirmations.
- **Responsive:** 1440 px is the design width; everything works at 768 px (tablet: sidebar collapses, tables
  drop secondary columns into a second line). At 390 px the approvals list and review drawer are fully usable;
  other screens are readable.

## Components

Each component lives in `apps/web/src/ui/` and is the only way that pattern is built.

- **Button**: variants `primary` (accent, one per view), `secondary` (bordered), `ghost` (toolbar, icon
  buttons), `danger` (bordered red; filled red only inside a confirm dialog). Sizes `sm` 28 px, `md` 32 px.
  `loading` shows a spinner and keeps the width; disabled buttons explain why in a tooltip or helper text.
- **IconButton**: square ghost button; `label` is required (used for `aria-label` and tooltip).
- **Input, Textarea, Select, Checkbox, Switch, DateTimeInput**: 32 px, 6 px radius, `--control` border,
  accent border plus focus ring on focus. Always used inside **Field**: a visible label (never a placeholder
  as label), optional helper text, unit suffix (`MB`, `days`, `%`), and an error line. Validation runs on
  blur and on submit, not on every keystroke; server errors (`treeifyError` details) are mapped to the field
  they name. `DateTimeInput` edits in the workspace time zone, shows the zone, and sends ISO 8601 with offset.
- **Table**: header on `--surface-2`, 40 px rows (36 px compact), row hover, the whole row is a link when it
  opens a detail page (with a real `<a>` for middle-click), numbers right-aligned and tabular. Loading shows
  skeleton rows; empty shows an **EmptyState** inside the table frame; errors show an inline alert with the
  reason and a Retry button.
- **Card**: surface with border and `--radius-lg`; optional header (title, actions). Used for grouped settings
  and dashboards, not as a substitute for tables.
- **Drawer**: right-side dialog, `role="dialog"`, `aria-modal`, labelled by its title; focus moves into it,
  is trapped, and returns to the trigger on close; `Esc` closes; header (title, meta, close), scrollable body,
  sticky footer for actions. Deep-linkable where it matters (`/approvals/:id`).
- **Modal / ConfirmDialog**: centred, max 480 px. Destructive confirmations name the object ("Delete provider
  'Brevo marketing'?"), state the consequence, and for irreversible or high-impact actions require typing
  the name. The confirm button says the action ("Delete provider"), never "OK".
- **Toast**: bottom-right (bottom-centre on phones), `aria-live="polite"` (errors `assertive`), auto-dismiss
  after 5 s for success, persistent for errors, with an optional action ("Undo", "Open").
- **EmptyState**: one sentence on what this list holds, one on how to fill it, and the primary action
  (or the command an agent would use, e.g. `templates` via MCP). No illustrations.
- **StatusPill**: dot + text, tones `neutral`, `info`, `good`, `warn`, `bad`. Standard mappings: draft →
  neutral "Draft"; in review → warn "In review"; published → good "Live"; rejected → bad "Rejected";
  superseded → neutral "Superseded"; disabled → neutral "Disabled".
- **Badge**: small count (navigation, tabs). **Kbd**: keyboard hint.
- **CodeView / JsonView**: mono 12 px on `--surface-2`, line wrapping toggle, copy button; JSON is
  pretty-printed and collapsible by key.
- **DiffView**: per-path list (added / removed / changed) with before and after values, plus a side-by-side
  text diff for long strings (e-mail HTML, text versions). Colour is backed by `+`/`−` markers and labels.
- **Tabs**: WAI-ARIA tabs (arrow keys move, Home/End), URL-synced where they are a page section.
- **Menu**: button + popover list, WAI-ARIA menu button pattern (arrow keys, type-ahead, `Esc`).
- **Skeleton**: shimmer blocks matching the final layout's size.
- **Preview frames**: sandboxed `<iframe srcdoc>` (no scripts), width presets desktop 640 px (the e-mail's
  own width inside a 1024 frame) and mobile 375 px.

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

## Roles and what they see

| Group | Who uses it | Shown when the role has |
| --- | --- | --- |
| Build | Builders (marketer, admin, owner) | `artifacts:read` (create actions need `artifacts:write`) |
| Design | Designers (marketer, admin, owner) | `artifacts:read` |
| Audience | Builders | `profiles:read` (imports need `profiles:write`) |
| Insights | Everyone with read access | `artifacts:read` (AI usage needs `workspace:admin`) |
| Approvals | Approvers, admins | `artifacts:read`; approve/reject need `artifacts:approve` |
| Settings | Admins | `workspace:admin` (except "Your preferences" and your own API tokens) |

Actions that would fail with 403 are not shown; if showing them helps understanding, they are disabled
with the reason ("Only approvers can approve").
