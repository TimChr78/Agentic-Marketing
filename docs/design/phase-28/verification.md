# Wave 5 release verification · 0.14.0

I assembles evidence on the integrated phase head after W/M/A/C/S. Current supplied results (axe 0/43,
12 visual routes) are starting evidence only. Checkboxes below are intentionally unchecked. Record SHA,
fixture version, browser/OS, width/theme/role, command, exit code, artifact and human reviewer per run in
`release-evidence.md`. Never equate mock rendering with application verification.

## Done criteria mapped to release gates

| Wave done criterion | Automated evidence | Human evidence / release threshold |
|---|---|---|
| Findability | Deterministic e2e confirms six tasks are reachable; does not measure unaided discovery | Five unfamiliar people each attempt all six tasks; ≥4/5 find and start **each** within 30s, no hints |
| Roles and edge cases | Builder/approver/viewer matrix for core flows; stale version, grouped approval, zero audience and failed request | Verify explanations and consequence summary; no hidden privilege escalation or accidental send |
| Mobile | Every matrix route at 390, both themes: page scroll width ≤clientWidth+1; action rectangles in viewport after ordinary vertical scrolling; no overlay intercept; execute core interactions | Read without zoom; Home, approvals, navigation, sign-in, lookup and agent Pause usable; reports readable; desktop-first canvas/e-mail have useful existing summary |
| Metrics | Assert period/zone, denominator, freshness and unavailable/suppressed states; reconcile shared fixture totals Home↔reports by same period/filter | Review direction/units and no-data truthfulness; no masked leakage or falsely healthy verdict |
| Accessibility | Zero axe violations on every route and core overlay/tab/state in both themes; functional keyboard assertions supplement it | Keyboard, focus return, 200% zoom and screen-reader core flow checklist below |
| Consistency | Rendered microcopy lint for known ID/metric/purpose keys outside reviewed exceptions; snapshots and label tests | Read every screen/tab's populated, empty, failure and loading copy in real/demo; no ambiguous verbs or raw labels |

Six agreed findability tasks (unchanged): send a broadcast; approve a change; pause an agent; find a person's
consent; see last week's newsletter results; create a form. Use isolated seeded workspaces/roles and safe test
recipients. Start timer on task reveal; success is finding and starting, not finishing delivery. Log individual
seconds and pass/fail per task, not an aggregate average. Product owner recruits participants and reviews failures.

## Automated checklist (I collects; area owners supply separate specs)

- [ ] `pnpm test:affected`, lint, typecheck; smoke and required functional suites against shared test services.
      Full suite CI. Build `build:live` before bundle tests; record exact repo commands used and exit codes.
- [ ] Enumerate `app/routes.tsx`, redirects and `e2e/matrix.mjs`; current matrix 43 scenarios is the minimum,
      not an exhaustive claim. Add reset-password, preferences/create, prompt/block details, tabs, demo links,
      public confirm/unsubscribe/expired/web versions and other existing recipient routes where absent.
- [ ] `e2e/axe.spec.ts`: zero violations; no newly suppressed findings in axe-known-issues. Include dialogs,
      nav drawer, action menus, data tables and error/restricted/loading states. Verify accessible busy labels.
- [ ] Existing 12 visual routes retained. I expands representative coverage for Consent, token drawer,
      providers partial error, empty lists, loading and every reported defect; full screenshot matrix remains
      1440/768/390 × both themes on deterministic fixture. Stable masks limited to genuinely volatile text;
      unmasked assertions validate names/statuses/dates hidden by masks. Reviewer approves changed baselines.
- [ ] New `phase28-mobile` spec checks every matrix destination for page overflow and hit testing of named
      actions at 390. Local scroll regions get focusable labels/cues and end-column reachability tests; clipping
      page content with overflow hidden does not pass. Open/close nav, search, menus, dialogs, footer at bottom.
- [ ] Work: approve exact version; grouped member review; stale review rejects safely; agent Pause by keyboard
      and touch. Marketing: zero audience prevents send; failed request preserves draft; report and summary usable.
- [ ] Audience: look up person, inspect consent, import validation; content: create form/template, preview
      provenance, draft/live labels, hosted confirmation by existing POST (GET never mutates); settings: read-only
      viewer, one-time secrets, token revoke/focus return; insights: tables and suppressed values agree with plot.
- [ ] Builder, approver, viewer each exercise allowed core steps and disallowed deep links; no forbidden CTA;
      permission-disabled empty states explain who can act. Include stale, empty, failed, unavailable, suppressed.
- [ ] Bundle caps and heavy-library boundaries from [budgets](skeletons-and-budgets.md) pass on fresh live dist.
      Attach actual static/automatic/optional closures. No silent missing-manifest skip in release CI.
- [ ] Microcopy lint asserts friendly text/options for known seeded keys; exceptions limited to Identifier,
      explicitly technical setup/code and user content. Inspect all toasts/errors manually as regex is incomplete.
- [ ] Delayed reads at 100ms/300ms/2s exercise reserved slots, reveal after 150ms only, stable bounds and recovery;
      retain old data on refresh. Capture LayoutShift entries on cold core flows; report CLS and causes.
- [ ] Normal/reduced-motion computed duration checks and JS settings; all allowed motion ≤180ms, none essential
      to action; reduced = zero and static progress text. Charts never animate.
- [ ] Dark-mode selected, hover, disabled, invalid, focus, editor chrome and charts contrast: text ≥4.5:1,
      large text ≥3:1, controls/meaningful marks ≥3:1. Use current semantic tokens; measured palette script plus
      real rendered colours, not screenshot appearance alone. Tenant content checked separately, not recoloured.
- [ ] Demo shares real screens and banner, no send/AI execution. Existing redirects/bookmarks and role gates pass.

## Manual checklist (human, both themes)

Run core flows: sign in → Home; compose/review broadcast → approval (including rejection/stale/grouped);
lookup person → consent; agent Pause; newsletter report → table; create form → preview. Include Settings token
and provider dialogs as representative shared overlays. Test 1440, 768 and 390 where applicable.

- [ ] Keyboard only: logical Tab/Shift+Tab order, visible focus, Enter/Space activation, Escape close, no trap
      outside modal; journey text view and existing keyboard actions work without dragging.
- [ ] Focus return: opening trigger regains focus after menu/dialog close; deep-linked review returns to
      meaningful queue/heading if no trigger exists; deletion/removal chooses next stable target.
- [ ] 200% browser zoom: reading order and labels remain, controls reachable, no two-dimensional page panning;
      local canvas can remain desktop-first with summary. At 390 touch targets ≥40×40, adjacent controls ≥8px gap.
- [ ] Screen reader (record pairing, e.g. NVDA/Firefox or VoiceOver/Safari): landmarks/headings, field labels,
      errors, status changes and tables make sense; skeleton announced once, copy success honest; no every-frame
      announcements. Read preview provenance and approval consequence before decisive action.
- [ ] Dark/mobile: no invisible selected state or obscured footer; no reliance on colour/hover; long names,
      localization-shaped long labels and large text wrap without losing action names.
- [ ] Five-participant timed findability sheet meets criterion per task. Record failures and fixes, then retest
      affected tasks; no declaration of success from developer familiarity.
- [ ] Human visually compares integrated before/after matrix including untouched areas affected by shared CSS.
      Approves baselines and README/docs screenshots, final DESIGN v2, and confirms all P1/P2 backlog entries closed.

Release gate: all wave criteria evidenced, P1/P2 closed, automated checks green and human gates signed. A missing
manual session remains outstanding, not “pass with caveat”. Regressions are polish repairs within existing scope;
new capabilities go to a later wave. I refreshes README/images only from final integrated build and names release
0.14.0; no screenshots from this mock stand in for product evidence.
