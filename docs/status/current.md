# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-08_

## Now

- **Phase 27 is merged** to `main` (#539, merge `5719d88`). It covers the remaining families and the recipient surfaces (#524–#530), and its tracker is #531.
  - Task PRs #532–#538 were followed by four rounds of fixes after Sol's reviews: #540–#549.
  - Sol approved at `bbe4c1a`.
  - Phase-level local e2e at `0f1e28d`: functional 75/75, axe 43/43 with 0 violations, visual 12/12.
- **Release 0.13.0 is in progress.** `scripts/release/prepare.mjs 0.13.0 --previous 0.12.0` ran on `release/0.13.0` and folded 19 fragments.
  - Breaking changes: none for commands, artifacts or configuration. The legacy demo is replaced by `/demo`.
  - The fixes to features that are new in 0.13.0 are folded into "Changed".
  - Remaining steps: merge the release PR, tag `v0.13.0`, run `scripts/release/verify.sh 0.13.0`, run `close-issues.mjs 0.13.0 --yes`, and close tracker #531.
- **The process work has landed** (batches 1 and 2: #515, #516, #518, #521, #522 and #523). The shared `am-test` stack runs through the pinned `/mnt/user/appdata/t3code/tools/bin/docker-compose` until Unraid 8 ships native Compose.

## Next

- **Phase 28, the polish pass and verification** (`docs/architecture/roadmap-wave-5.md`):
  - a microcopy pass;
  - motion limited to orientation and feedback (120–180 ms, honouring reduced motion);
  - dark-mode and mobile audits;
  - per-route bundle budgets and skeletons without layout shift;
  - DESIGN.md v2 final;
  - refreshed screenshots and README images.
- **Carry-overs into Phase 28:**
  - The mutation sweep is still partly lexical for `Button` handlers (`mutationSweep.test.ts` `MUTATING_HANDLER`). Detect async commands the way `Select` now does (Sol P3).
  - `Select` drops a caller's `aria-description` when it is unrestricted (`ui/form.tsx`, Sol P3).
  - The role-dropdown demo test should also assert that an interaction makes zero submissions (Sol P3).
  - `pnpm test:affected` defaults to `origin/main`. On a phase branch it should default to the phase branch, because unclassified paths that were already merged select the full suite.
  - Dependabot reports 4 moderate alerts on `main`. Triage them.

## Blocked / decisions needed

- These are open questions for the user and block nothing:
  - Should there be a public signup GET page?
  - Is the demo walkthrough note (kept as a short notice on Home) enough?
  - Where should Consent Topics live?

## Lessons from Phase 27

- **Sol's review loop.** Review rounds 2–4 found narrower issues each time, mostly in the new demo isolation. Two things should cut the rounds:
  - brief Sol to block only on P1 or P2 defects a person can actually hit;
  - give each security-like boundary (demo isolation) its own adversarial checklist in the contract.
- **Visual masking races.** `volatileMasks()` only masks what has rendered. Wait for late panels before masking (agents comparison, #544).
- **Palette drags in e2e.** Taller rows can push the drag source below the fold. Filter with the palette search before dragging (#541).

## Last green

- `main` at `5719d88` (Phase 27 merged; CI green on `bbe4c1a`).
- The last release is v0.12.0 (`f64fdcc`), released and verified.
