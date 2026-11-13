# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-12_

## Now

- **Phase 28, the polish pass and verification, is merged** to `main` (#569, merge `9fbe296`). It is the last phase of Wave 5 (#439). The tracker is #553.
  - Contract: #554 (`docs/design/phase-28/`).
  - Carry-overs: #561.
  - Foundations: #562.
  - Areas: W #563, M #564, A #565, C #566 and S #567.
  - Final integration: #568.
  - Fixes from Sol's review: #570. Sol approved them on re-check.
  - Evidence on the final head: full functional e2e 152, axe 43 with 0 violations, visual 12/12, web unit tests 1,011, bundle budgets 151.
- **v0.14.0 is released and verified** (`5897c1a`). Tracker #553 is closed.
- **v0.14.1 is released and verified** (tag `v0.14.1`, release PR #573). It covers the CodeQL alerts that had been open since 2026-10-30.
  - Seven polynomial ReDoS sites are now linear.
  - The archive and web-version sanitiser is now a linear, quote-aware scanner, with parse5 8.0.1 as the final judge. Normal e-mail takes the fast path byte-identically. The cleaned output is re-checked, and the sanitiser fails closed if anything active remains.
  - The tracking pixel is removed before the check, styles are escaped with `\3c`, and the real rendered page is covered by tests.
  - Sol approved after four rounds.
  - Alert 5 (MD5 used for NATS shard selection) was dismissed as a false positive.
  - The `uuid` Dependabot alert is still accepted, because it only affects the dev spike.
- **The audit-fix plan runs as patch releases 0.14.2 to 0.14.8.** The 2026-11-08 audit filed 81 issues (#574–#654). Each was validated against the code: 79 are real, 1 is a duplicate and 1 is not reproducible.
  - **0.14.2** fixes all eight S1s (security and compliance) and is released. Its review ran four rounds; HY4 reviewed the last one after the Codex quota ran out.
  - **0.14.3** (install, deploy and release tooling) is released.
  - **0.14.4** (consent, privacy records and delivery reliability, plus #664) is released and verified. Sol approved after 11 rounds; most were on the unsubscribe-link check (hiding forms, then super-linear inputs). The check now has a 1 s budget and a 512-level nesting cap, and its remaining limits are tracked in #707. `fast-xml-parser` is pinned to 5.12.0 (Dependabot 21).
  - **0.14.5** (analytics correctness) is released and verified. Sol approved after six rounds; one shared `campaignIdentityMap` (window and current hash version) now feeds the headline, member rows and holdouts. The suppression gap is filed as #692.
  - **0.14.6** (admin UI stale data, migration 0089) is released and verified (the first release run hit an `expectLinear` flake; `expectLinear` now re-measures, #730).
  - **0.14.7** (authoring, approvals and forms) is released and verified. P3 follow-ups: #735.
  - **0.14.8** (alerts, schedules and jobs) is released and verified: the last of the seven audit releases. Sol approved after three rounds (DST resolution cross-checked against a minute scan in nine zones; retry-stable, strictly increasing refresh tokens). Up to four delegates run at once (raised 2026-11-12).
  - **0.14.9** (dependency updates, #727) is released and verified: the auth stack, `htmlparser2` 12, `jsdom` 31, OpenTelemetry 0.301, Biome 2.6 and the remaining group.
  - **0.14.10** (bug follow-ups: #735, #732, #671, #672, #673, #746) is released. Sol approved. parse5 8.1 indexes the open-element stack, so the #673 read cap is now a backstop.
  - **0.14.11** (privacy and security) is released: Sol approved after eleven rounds; webhook replay identity is the headers a mapping reads (documented residual: clock- or random-dependent reads may publish a retry twice, never lose one).
  - **0.14.12–0.14.15** (the rest of the 2026-11-12 audit): approved, releasing in order. Plan: https://claude.ai/artifact/BDXuwrEBa6hevSKU4s9vAL
  - **Follow-ups filed (S3):** #671, #672 and #673.

## Owner sign-off (Wave 5 done criteria that cannot be automated)

These are listed in `docs/design/phase-28/verification.md`. They are unchecked and wait for the owner:
- Five unfamiliar participants each find and start the six agreed tasks unaided within 30 seconds.
- Manual checks of the core flows: keyboard, focus return, 200% zoom and screen reader.
- Approval of the visual baselines.

When these are signed off, the Wave 5 epic #439 can close.

## Next

- After 0.14.0, Wave 5 is complete in code. The next step depends on the owner. Candidates from the open issues:
  - #441: segments on the platform's own engagement.
  - #173: organise the test suite by domain.
  - #183: an AI PR reviewer.
  - #208: contributor scaffolding.
- **P3 follow-ups from Phase 28:**
  - `ui/Button.tsx:68`: an iconless button can change width while busy. Reserving the slot widened idle buttons and wrapped the People filter row at 390, so a fix needs a layout-neutral approach.
  - `apps/web/test/phase28-bundle.test.ts`: strengthen missing-import rejection, the accounting of automatically mounted dynamic closures, and artifact-type, alias and tab completeness.

## Lessons from 0.14.4–0.14.6

- **A static visibility check needs a work budget from the start.** Reviews of the unsubscribe check alternated between new hiding forms and new super-linear inputs; a time budget and caps on nesting, selector classes and colour length ended the loop. Decide early which limits are P3 (documented) and which block.
- **Key every read by what identifies it.** `useApi` keeps the previous data during a reload, which is wrong whenever the id, filter or period changes. `useKeyedApi` plus a guard test with an allowlist found 15 more sites.
- **One shared function for one decision.** The campaign headline, member rows and holdout each scoped the identity map differently and disagreed near the bound; a single `campaignIdentityMap` fixed it.
- **Run the full server suite before reporting.** Delegates ran focused files and missed `v075-measurement` and `sent-at-migration`, which CI then caught.

## Lessons from 0.14.1

- **Check GitHub code scanning and Dependabot at every release.** Twelve high CodeQL alerts sat untriaged for nine days.
- **A hand-written HTML sanitiser needs a spec parser as its judge, applied to the final page.** Each review round found a new disagreement between the regex or scanner and the browser (stray quotes, reassembled tags, `noscript`, pixel removal after the check, style breakout).
- **Use scaling checks, not fixed millisecond limits.** Absolute limits flaked on CI runners; `expectLinear` (`test-support/linear.ts`) compares t(4n) with t(n).

## Lessons from Phase 28

- **One shared list for the "area landed" state.** Every area edited the same `fixme` and strict-area lines and conflicted with the others. The `STRICT` and `LANDED` lists fixed that. Start with such lists the next time several tasks flip a shared flag.
- **e2e shares one seeded database.** New specs that assumed an untouched seed failed only in the full suite (#564, #566). `docs/process/delegates.md` now requires state-independent assertions, the **full** functional run and `pnpm lint` before a delegate reports.
- **Vitest runs without globals,** so Testing Library never registered cleanup. A global `afterEach(cleanup)` now lives in `apps/web/test/setup.ts`.
- **Check fixes for regressions before accepting them.** A delegate's P3 fix (the reserved button slot) caused a visible regression, so the integrator reverted it.

## Last green

- `main` at `9fbe296` (Phase 28 merged; CI green on `6332572`).
- The last release is v0.14.11, released from `main`; v0.14.10 is verified.
