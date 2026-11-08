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

Evidence collected on integrated head `c88b63e` (area branches merged), fresh seeded run-scoped
database per suite, Linux, Playwright `v1.64.1-noble` Chromium, shared test stack with
`TEST_PORT_OFFSET=100`. Commands and exit codes are in [release evidence](release-evidence.md).

- [x] `npx vitest run --project web` exit 0 (100 files, 1,003 tests); `npx vitest run --project docs`
      exit 0 (6 files, 38 tests); `corepack pnpm lint` exit 0; typecheck exit 0; full functional suite
      exit 0 (151 passed). `build:live` exit 0 before the bundle tests; every command and exit code is
      recorded in [release evidence](release-evidence.md).
- [x] Enumerated `app/routes.tsx`, `app/redirects.ts` and `e2e/matrix.mjs`: 45 named matrix scenarios
      (43 route/scenario tests plus the two signed-out screens) at 1440/768/390 × light/dark = 258
      screenshots. Prompt and block details are in the matrix; reset-password is covered by
      `phase28-mobile`, public confirm/unsubscribe/expired and hosted versions by `hosted-pages.spec.ts`,
      preferences/create by unit tests, and demo deep links by `demo-smoke.spec.ts`.
- [x] `scripts/e2e-docker.sh axe` exit 0: 43 passed, 2 skipped, zero violations, `axe-known-issues.json`
      has 0 entries. The matrix covers dialogs, nav drawer, menus, data tables and error/restricted/loading
      states; `phase28-states` verifies the accessible busy label.
- [x] The 12 committed visual routes stay approved; `scripts/e2e-docker.sh visual` exit 0 (12 passed).
      The full screenshot matrix is 258 images at 1440/768/390 × both themes. Consent, token drawer,
      providers partial error, empty lists and loading states are asserted by their area specs, and
      changed baselines are listed in [release evidence](release-evidence.md).
- [x] `e2e/phase28-mobile.spec.ts` checks page-level overflow for every nav route at 390 and the compact
      agents status/24-hour summary; it also opens/closes the nav drawer. The full functional suite
      passed, including local-scroll and footer checks in the area specs.
- [x] Work and marketing acceptance passed in the full suite: exact-version approval, grouped review,
      stale-review warning, agent Pause, zero-audience prevention, draft preservation and usable reports
      (`e2e/phase28-work.spec.ts`, `e2e/phase28-marketing.spec.ts`).
- [x] Audience/content/settings acceptance passed: person lookup and consent, import validation, form and
      template creation, preview provenance, draft/live labels, hosted POST (GET never mutates), read-only
      viewer, one-time secrets, token revoke/focus return, and report tables agreeing with the plot
      (`phase28-audience`, `phase28-content`, `phase28-settings-insights`).
- [x] `e2e/phase28-roles.spec.ts` exercises the builder, approver and viewer core flows and deep links;
      no forbidden CTA or hidden escalation. Stale, empty, failed, unavailable and suppressed states are
      covered by the area and states specs.
- [x] Bundle caps pass on a fresh `build:live` dist: `PHASE28_REQUIRE_BUNDLE=1 npx vitest run
      apps/web/test/bundle.test.ts apps/web/test/phase28-bundle.test.ts` exit 0 (151 tests), including
      the missing-manifest failure and initial/lazy/cold unions. Manifest-derived actuals are published
      in [release evidence](release-evidence.md); no ceiling was raised.
- [x] `apps/web/test/phase28-microcopy.test.ts` exit 0: I, W, M, A, C and S each report 0 findings.
      Exceptions stay limited to the label registry, Identifier, developer JSON/source views and fixture
      technical values; toasts and errors were inspected manually in the area reviews.
- [x] Delayed reads at 100 ms, 300 ms and 2 s reserve the slot immediately, reveal shapes only after
      150 ms, keep the left edge and width within 1 px of the ready table, and keep cumulative layout
      shift ≤ 0.1 (`e2e/phase28-states.spec.ts`, newly added in this pass). The unit test covers the
      150 ms threshold and refresh retention.
- [x] `e2e/phase28-states.spec.ts` asserts reduced motion at computed-style level (0 durations/delays, no
      infinite animation), the static progress glyph, and an entering overlay ≤180 ms. No CSS or JS
      animation runs on charts, counters or skeletons.
- [x] `python3 docs/design/showcase/verify_palette.py` exit 0: contrast, HTML/token parity and ramp order
      pass. No palette value changed in the phase; dark selected/hover/disabled/focus and chart marks
      therefore keep their measured ratios, and axe passes in both themes.
- [x] `e2e/demo-smoke.spec.ts` passed in the full functional suite: the demo shares the real screens and
      banner and never sends or executes AI; existing redirects, bookmarks and role gates still pass.

## Manual checklist (human, both themes)

Run core flows: sign in → Home; compose/review broadcast → approval (including rejection/stale/grouped);
lookup person → consent; agent Pause; newsletter report → table; create form → preview. Include Settings token
and provider dialogs as representative shared overlays. Test 1440, 768 and 390 where applicable.

- [ ] **owner sign-off** — Keyboard only: logical Tab/Shift+Tab order, visible focus, Enter/Space activation, Escape close, no trap
      outside modal; journey text view and existing keyboard actions work without dragging.
- [ ] **owner sign-off** — Focus return: opening trigger regains focus after menu/dialog close; deep-linked review returns to
      meaningful queue/heading if no trigger exists; deletion/removal chooses next stable target.
- [ ] **owner sign-off** — 200% browser zoom: reading order and labels remain, controls reachable, no two-dimensional page panning;
      local canvas can remain desktop-first with summary. At 390 touch targets ≥40×40, adjacent controls ≥8px gap.
- [ ] **owner sign-off** — Screen reader (record pairing, e.g. NVDA/Firefox or VoiceOver/Safari): landmarks/headings, field labels,
      errors, status changes and tables make sense; skeleton announced once, copy success honest; no every-frame
      announcements. Read preview provenance and approval consequence before decisive action.
- [ ] **owner sign-off** — Dark/mobile: no invisible selected state or obscured footer; no reliance on colour/hover; long names,
      localization-shaped long labels and large text wrap without losing action names.
- [ ] **owner sign-off** — Five-participant timed findability sheet meets criterion per task. Record failures and fixes, then retest
      affected tasks; no declaration of success from developer familiarity.
- [ ] **owner sign-off** — Human visually compares integrated before/after matrix including untouched areas affected by shared CSS.
      Approves baselines and README/docs screenshots, final DESIGN v2, and confirms all P1/P2 backlog entries closed.

Release gate: all wave criteria evidenced, P1/P2 closed, automated checks green and human gates signed. A missing
manual session remains outstanding, not “pass with caveat”. Regressions are polish repairs within existing scope;
new capabilities go to a later wave. I refreshes README/images only from final integrated build and names release
0.14.0; no screenshots from this mock stand in for product evidence.
