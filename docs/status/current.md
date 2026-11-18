# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-18_

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
  - **0.14.10** (bug follow-ups: #735, #732, #671, #672, #673, #746) is released and verified. Sol approved. parse5 8.1 indexes the open-element stack, so the #673 read cap is now a backstop.
  - **0.14.11** (privacy and security) is released and verified: Sol approved after eleven rounds; webhook replay identity is the headers a mapping reads (documented residual: clock- or random-dependent reads may publish a retry twice, never lose one).
  - **0.14.12** (analytics and experiments) is released and verified: Sol approved after six rounds (ads attribution is bounded in memory, pairs and time).
  - **0.14.13** (UI freshness and e-mail) is released and verified: Sol approved after five rounds (ordered reference observations, one re-check per return).
  - **0.14.14** (operations and release tooling) is released: Sol approved after six rounds (one release queue with `queue: max`, tag reserved before publishing, `latest` only for the newest stable release, workflow shell steps checked by `bash -n`).
  - **0.14.15** (delivery and data edge cases) is released and verified: Sol approved after four rounds (retryable SNS refusals, a non-blocking idempotency lock). This completes the 2026-11-12 audit plan.
  - **0.14.16** (security and availability: #838, #829, #817, #818) is released and verified. Sol confirmed every finding on these issues closed over three rounds; its last round still said BLOCK, on pre-existing error-text sites elsewhere in the codebase, which are released separately as the #885 sweep (0.14.20). Plan: https://claude.ai/artifact/BpmvEUAQFvWKJfDEJmMMR9 (previous plan: https://claude.ai/artifact/BDXuwrEBa6hevSKU4s9vAL)
  - **0.14.17** (artifact integrity: #867, #868, #869, #871) is released and verified: Sol approved after three rounds (singleton uniqueness enforced in the database, archived duplicates restored unpublished, deadlocks answered as a retryable `conflict`).
  - **0.14.18** (packaging hardening: #870) is released and verified: Sol approved (admin port on loopback by default via `AM_BIND`, empty template database passwords, role-aware healthcheck, per-run smoke ports, digest-pinned images).
  - **0.14.19** (privacy and test reliability: #692, #820, #828, #830, #831, #840) is released and verified: Sol approved after four rounds (complementary suppression per total, e-mail totals protected by any member with in-window e-mail activity, per-variant k floor in experiment results).
  - **0.14.20** (error-text sweep and reliability: #885, #877, #892, #893) is released: Sol approved after ten rounds (one redaction rule, redact before cut, applied at the executor for every AppError, at policy-reason creation and at each stored error column; Docker-assigned smoke ports; a deterministic linear-helper self-test; uuid pinned to 11.1.1). This completes the 2026-11-13 plan.
- **The 2026-11-14 audit plan runs as patch releases 0.14.21 to 0.14.23.** Two audits filed 29 issues (#898–#920 against v0.14.20, #928–#933 against v0.14.21); all were confirmed against the code. Plan: https://claude.ai/artifact/CDenbTFevFfh33DCMtJUrN (batches ship as they are approved, so the release numbers differ from the plan's).
  - **0.14.21** (artifact and agent integrity, audit trail and idempotency, privacy and reporting: #899, #900, #901, #903, #904, #905, #906, #907, #908, #909, #910, #911, #912, #915, #916, #917, #918; migrations 0093–0095) is released and verified.
  - **0.14.22** (operations hardening and consent/replay: #926, #928, #929, #930, #931, #932, #933; migration 0096) is released and verified: Sol approved the two batches after five and three rounds (request body limits on the auth routes with byte counting, URL credentials kept out of logs, traces and `am doctor`, form consents stamped with the action time, idempotent agent replays that skip the policy engine, send and enrollment keys bound to an immutable request fingerprint).
  - **0.14.23** (security hardening: #898, #902, #913, #914, #919, #920) is released and verified: Sol approved after ten rounds. The credential redaction is the 0.14.20 rule list, unchanged and run first, plus two additive rules (camelCase credential keys, URL passwords) settled in one call; a hand-written scanner was dropped after five rounds. CSRF origin matching follows Better Auth, `am reset-password` is one transaction with an audit entry, Teredo addresses are decoded, and stored send reasons are bounded. This completes the 2026-11-14 plan.
- **The 2026-11-16 audit plan runs as patch releases 0.14.24 to 0.14.26.** 29 issues (#936–#966, including three from the Agentic SEO port) were checked against v0.14.23: 28 confirmed, #952 closed as not reproducible. Plan: https://claude.ai/artifact/4HHkszSHhAoQ2tXoFzysGm
  - **0.14.24** (security, send integrity and AI budget: #940, #941, #942, #943, #944, #945, #946, #947, #948, #949, #954, #956, #960, #964; migrations 0097–0099) is released and verified. Sol approved the four batches after two to six rounds each: Better Auth receives only exact origins, a broadcast decides per person across profile merges (a merge during a batch counts as after the send), platform key prefixes are reserved, the AI budget counts every billed token in the month it was first recorded, `prompts.test`/`ai.classify`/`ai.score` are spend actions, and redaction adds leading-separator and model-provider keys as passes after the 0.14.23 rules. Follow-up: #972 (holdout report memory).
  - **0.14.25** (consent evidence, redaction value shapes, reporting and ads: #936, #937, #953, #958, #959, #962) is released and verified. Two batches needed scope cuts after review: #936 keeps the newer-signup evidence rule and leaves serialising consent writers, merges and erasure to #978 (0.15.0); #937 covers structured values, short schemes, escaped JSON, URL-encoded pairs and Pwd/Pass names as passes after the released rules, while PEM blocks, typographic quotes and `=>` separators moved to #989.
  - **0.14.26** (approvals on archived artifacts, mandate repair and `artifacts.archive`, reversed replays after undo, doctor endpoints, OTLP/env forwarding with a syntax-aware env guard, Recipes install and retry: #950, #951, #955, #957, #961, #963, #965, #966; migration 0103) is released and verified.
  - **0.14.27** (holdout report in SQL with paging #972, 30-day idempotency key retention #976 with migration 0104, Better Auth 1.7.23 with its plugins grouped and the minor/patch updates replacing Dependabot #980/#981) is released and verified. Follow-ups: #985 (holdout chain parity), #986 (identity map memory), #989 (redaction shapes needing input context), #996 (AppError details unredacted).
  - **0.14.28** (AppError details redacted at every exit: #996) is released and verified.
  - **0.15.0** (consent, identity and erasure lock protocol, #978; Node 26, #1005) is released and verified: prepared keys #983, transactional outbox #988, durable erasure #1009, lock activation #1010. Drain upgrade; scheduler replica required; erasure finishes in a background job; retention pruning of unconfirmed signups paused. Follow-ups: #1008 (alerts and guardrails read delayed events), #1011 (journey trait writes vs. merges).
  - **0.15.1** (the five bugs from the 0.15.0 wave and promise-safety follow-ups: #985, #986, #989, #1008, #1011, #1014, #1025, #1028; oxlint type-aware rules #1002) was tagged but not published (its release run failed on redaction wall-clock budgets).
  - **0.15.2** (everything in 0.15.1, plus growth-only redaction timing checks #1033) is released and verified.
  - **0.15.3** (erasure mitigation for events reappearing in ClickHouse, #1034 — full read-time exclusion in 0.17.0, #1037; the outbox barrier sees mixed-subject batches, #1038) is released and verified.
  - **0.16.0** (PostgreSQL 18 for new installs with an upgrade path from 16, #1001; message-engagement segment conditions, #441; unsubscribe CSS warning, #872) is released. Next: 0.17.0, the erasure completion contract (#1037).
  - Follow-ups filed: #936 (an unchanged-status signup leaves no ledger row) and #937 (redaction value shapes the rules do not consume).
  - Decisions taken with the recommended options: #906 documents the same-key retry rule and adds an optional key to MCP tools; #904 documents the header-copying limit; #917 keeps `unattributed` and adds `unmatched` and `spendTruncated`; #911 archives the older of two active mandates; #900 hides archived artifacts from `artifacts.list` unless `includeArchived` is set.
  - **Follow-ups filed (S3):** #671, #672 and #673.

## Owner sign-off (Wave 5 done criteria that cannot be automated)

These are listed in `docs/design/phase-28/verification.md`. They are unchecked and wait for the owner:
- Five unfamiliar participants each find and start the six agreed tasks unaided within 30 seconds.
- Manual checks of the core flows: keyboard, focus return, 200% zoom and screen reader.
- Approval of the visual baselines.

The Wave 5 epic #439 is closed (complete in code); these checks are tracked in #992.

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
- The last release is v0.16.0, released from `main`; v0.15.3 is verified (v0.15.1 was tagged but never published).
