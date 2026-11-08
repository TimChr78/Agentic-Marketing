# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-08 (night)_

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
- **Release 0.14.1, a security patch, is in progress.** It covers the CodeQL alerts that had been open since 2026-10-30 and is merged as #572.
  - Seven polynomial ReDoS sites are now linear.
  - The archive and web-version sanitiser is now a linear, quote-aware scanner, with parse5 8.0.1 as the final judge. Normal e-mail takes the fast path byte-identically. The cleaned output is re-checked, and the sanitiser fails closed if anything active remains.
  - The tracking pixel is removed before the check, styles are escaped with `\3c`, and the real rendered page is covered by tests.
  - Sol approved after four rounds.
  - Alert 5 (MD5 used for NATS shard selection) was dismissed as a false positive.
  - The `uuid` Dependabot alert is still accepted, because it only affects the dev spike.

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

## Lessons from 0.14.1\n\n- **Check GitHub code scanning and Dependabot at every release.** Twelve high CodeQL alerts sat untriaged for nine days.\n- **A hand-written HTML sanitiser needs a spec parser as its judge, applied to the final page.** Each review round found a new disagreement between the regex or scanner and the browser (stray quotes, reassembled tags, `noscript`, pixel removal after the check, style breakout).\n- **Use scaling checks, not fixed millisecond limits.** Absolute limits flaked on CI runners; `expectLinear` (`test-support/linear.ts`) compares t(4n) with t(n).\n\n## Lessons from Phase 28

- **One shared list for the "area landed" state.** Every area edited the same `fixme` and strict-area lines and conflicted with the others. The `STRICT` and `LANDED` lists fixed that. Start with such lists the next time several tasks flip a shared flag.
- **e2e shares one seeded database.** New specs that assumed an untouched seed failed only in the full suite (#564, #566). `docs/process/delegates.md` now requires state-independent assertions, the **full** functional run and `pnpm lint` before a delegate reports.
- **Vitest runs without globals,** so Testing Library never registered cleanup. A global `afterEach(cleanup)` now lives in `apps/web/test/setup.ts`.
- **Check fixes for regressions before accepting them.** A delegate's P3 fix (the reserved button slot) caused a visible regression, so the integrator reverted it.

## Last green

- `main` at `9fbe296` (Phase 28 merged; CI green on `6332572`).
- The last release is v0.13.0 (`f3bd868`), released and verified.
