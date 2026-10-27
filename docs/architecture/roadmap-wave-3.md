# Roadmap, wave 3 (planned 2026-10-26)

Wave 2 (Phases 6 to 11) is built: delivery beyond SMTP, SMS, consent everywhere, performance marketing, scale and operations, enterprise and ecosystem. MartechSignal went live on 0.2.2, and running it for a few days produced a clear signal: the platform is broad enough, but **installing, upgrading and operating it** is still manual, and a handful of everyday flows have rough edges.

Wave 3 takes in every open issue, and is deliberately critical about them. Issues #64–#102 are a gap analysis against large commercial suites. Many describe good features for a team with a sales force, an app or a shop. This platform is run by a team of one, with one live pilot that is a content site and a newsletter. Those issues are placed by the same rules as everything else, and several are **parked**: kept open and wanted eventually, but not in this wave.

## How it is prioritised

The same four questions as [wave 2](roadmap-wave-2.md#how-it-is-prioritised), in this order:
1. **Does it unblock real use now?** The live pilot comes first, and the next self-hoster after it.
2. **Is it a prerequisite?** E.g. the metric layer comes before dashboards, alerts and campaign evaluation.
3. **Value per effort** for a team of one.
4. **Risk if postponed:** compliance, data loss and silent regressions outrank convenience.

Two rules are added for wave 3:
- **A feature needs a user.** A gap that matters only to a use case nobody runs (an app, a shop, a sales team) waits until a pilot brings that use case. These are listed under "Later, when a pilot needs it", with the trigger.
- **Don't rebuild a category.** Where a mature, specialised tool does the job and the platform can feed it (session replay, help-desk inboxes, feature-flag services), we integrate first and build later, if at all.

## The phases at a glance

| Phase | Theme | Main contents | Depends on | Size* | "Done" means |
|---|---|---|---|---|---|
| **12** ✅ | **Install and upgrade** (done in 0.2.4–0.2.5) | Compose bundle per release, production-ready compose defaults, `am init` / `am doctor` / `am smoke`, backups and restore, the running version everywhere, release checks that catch regressions | – | M | A new self-hoster installs, upgrades and restores from the release page alone, and `am doctor` tells them what is wrong |
| **13** | **Pilot correctness** | Consent exits from journeys, UTM in plain text, fast retries for confirmations, layout-only journey edits, approval bundles, agents proposing settings, strict inputs evidence, the leftovers from Phase 12 | – | M | Four weekly issues in a row with no manual workaround in the pilot runbook |
| **14** | **Admin UI for daily use** | Full-width layouts, smaller bundles, server-side filters and aggregates, structured editors for experiences and purposes, live journey stats, SVG logos, small fixes | – | M | The weekly review and approval flow is comfortable on a wide screen and a phone |
| **15** | **Newsletter and lifecycle e-mail** | Preference centre with topics, newsletter archive and web version, reusable content blocks, pre-send checks, subject A/B tests and send windows, static audiences, two journey building blocks | 13 | L | The pilot's issues use shared blocks, readers manage topics, and every issue has a web version |
| **16** | **Measure and report** | A read-only metric layer, campaign object and evaluation, holdouts, threshold alerts | 15 | L | An agent answers "how did the last four issues and the welcome journey do" from one command, with uplift against a holdout |
| **17** | **Agents with bounded autonomy** | Business context for agents, autonomy modes, the campaign agent | 16 | L | An agent proposes a whole campaign from a brief, and runs low-risk changes within limits a person set |
| Later | | Only when a pilot needs it: see the list below | | | |
| Parked | | Session replay, a conversational inbox, in-app messaging, feature flags, predictive models: kept open, not now; see the list below | | | |

\*Size in working sessions of the current kind: S ≈ 1, M ≈ 2–3, L ≈ 4+.

Phases 12, 13 and 14 have no dependency on each other. Phase 12 goes first because every later release is installed through it. The small privacy fix in Phase 13 (#108) does not wait for it: it ships first, as 0.2.3.

## Phase 12: install and upgrade

Goal: a self-hoster installs, upgrades, checks and restores the platform without cloning the repository and without editing release files. The pilot upgraded four times in two days and found two regressions (#42, #115) by hand that the release tests had missed.

- **A release you can install from** (#119):
  - a Compose bundle on each release (`docker-compose.yml`, `.env.example`, `compose.override.example.yaml`, `UPGRADING.md`), with a checksum;
  - an "Upgrading from the previous version" block in a fixed shape in every release note: migrations, new or changed variables, breaking changes, manual steps, the one-line upgrade.
- **Compose defaults that need no edits** (#123):
  - `restart: unless-stopped` on every service, healthchecks for NATS and Valkey;
  - the public listener published from an environment variable;
  - `compose.override.example.yaml` for tunnels on another network, bind mounts, a backup service and resource limits;
  - the documented rule: never edit `docker-compose.yml`, put site changes in the override.
- **`am init`, `am doctor`, `am smoke`** (#122):
  - `init` writes `.env` with generated secrets (never printed) and asks for the URLs;
  - `doctor` checks secrets, HTTPS for MCP, the links host, the public listener, trusted proxies against the client IPs actually seen, unknown or missing variables for this version, sending-domain DNS and egress to the providers; it also runs at startup, as warnings;
  - `smoke` runs the post-upgrade checks the pilot did by hand: admin paths 404 on the public host, dot-segments 400, assets served, MCP scopes, the provider configured, a signup round trip.
- **Backups and restore** (#121):
  - `am backup` (Postgres `pg_dump -Fc`, optionally ClickHouse) with a manifest of version and migration head; `am restore`, which refuses a newer schema unless forced;
  - an optional `backup` service in the bundle (`BACKUP_CRON`, `BACKUP_KEEP_DAYS`);
  - an automatic Postgres backup before migrations, unless `SKIP_PRE_UPGRADE_BACKUP=true`;
  - restore tested in CI; docs on what each store holds and what is lost without a ClickHouse backup.
- **The running version, everywhere** (#120): one build-time version in MCP `serverInfo`, OpenAPI, `/healthz`, the first log line, `workspace.get` and the UI, with a test that fails when one of them drifts. The "update available" notice stays optional and off by default.
- **Release checks that catch what the pilot caught:**
  - the Playwright tests in CI (#59), so a browser-only regression like #115 fails the build;
  - `am smoke` against the built image in the release workflow;
  - the local test stack documented (ClickHouse `custom_settings_prefixes=SQL_`), and the warehouse export tests passing locally or fixed (#54).

Done when a fresh Compose install and an upgrade from 0.2.2 both work from the release page alone, `am doctor` is green on the pilot, and a restore has been tested in CI.

**Status (2026-10-26): done.** Shipped in [0.2.4](../../CHANGELOG.md#024---2026-10-26) (#119–#123, #59, #54) and [0.2.5](../../CHANGELOG.md#025---2026-10-26) (#129–#135, the pilot's findings from upgrading to 0.2.4). The pilot upgraded 0.2.2 → 0.2.4 → 0.2.5 from the release page, `am doctor` and `am smoke` run there, and CI backs up and restores Postgres and ClickHouse with the row policies on. What the pilot found on 0.2.5 (#138, #139) is minor and moved to Phase 13. Lessons:
- the first real upgrade found seven problems the tests had not; a release is only checked once the pilot has upgraded with it;
- tests must run the production defaults: the ClickHouse backup was empty under the default row policies, and the test used a table without one (#129);
- `am doctor` is only useful when it has no false positives (#132).

## Phase 13: pilot correctness

Goal: the pilot's weekly loop (Hermes drafts the issue, Tim approves, the broadcast goes out, the welcome journey runs) needs no workaround.

- **People who withdraw consent leave journeys** (#108, privacy): on withdrawal, objection or erasure for a journey's purpose, active participants exit with `consent_withdrawn`, using the rule from ADR-0014; no later step runs. Ships first, as 0.2.3.
- **UTM tags in the plain-text part too** (#118), with the same rules as HTML.
- **Fast retries for confirmations** (#109): a retry schedule per stream (seconds, then minutes, for double opt-in and transactional mail); `attempts`, `nextAttemptAt` and the last error in `messages.list` and the UI.
- **Layout is not content** (#117): a drag threshold, positions saved without a version, and "Discard draft" in the editor.
- **One review for one decision** (#107): approval bundles, so a template and its broadcast (or form) are reviewed in one drawer and published atomically in dependency order. This halves the weekly approvals.
- **Agents propose settings** (#106): `workspace.proposeUpdate` for low-risk settings (time zone, name), applied when a person approves. Never for providers, tokens, secrets, members, roles or the approval policy.
- **Evidence for strict inputs** (#124): unknown-key events per client in Postgres (key names, not values), shown per token and over `system.inputWarnings`, with a "safe to turn on" hint. Then make `STRICT_INPUTS=true` the default in the first minor release after the pilot's clients have sent no unknown keys for a week.
- **Step-up rate limit** (#61) on token edits, as for sign-in.
- **Leftovers from Phase 12:** the public listener's default host port collides with `AM_PORT=3210` and `am doctor` misses it (#138, the one that can stop an upgrade); clearer backup, upgrade-notes and smoke output (#139).

Done when four consecutive Friday issues go out with one approval each and the pilot runbook has no step that works around the platform.

**Status (2026-10-26): built, waiting for the pilot.** Every item above, and #138/#139, is implemented for 0.2.6 (see the CHANGELOG). Still open:
- the evidence itself: four Friday issues with one approval each (bundles, #107), and a quiet week of `system.inputWarnings` before `STRICT_INPUTS=true` becomes the default (#124);
- #45: close once Hermes has confirmed the dotted tool names work for it (or switched to `MCP_TOOL_NAME_STYLE=underscore`).

Housekeeping: #45 is resolved (MCP instructions, `artifacts.types({type})`, and the template-per-issue pattern documented on the broadcast type) and can be closed once the dotted tool names are checked against Hermes.

## Phase 14: admin UI for daily use

Goal: the screens a person uses every week (approvals, journeys, people, messages) are quick and roomy.

- **Use the window** (#114): page width tokens (`reading`, `default`, `full`), the journey builder full-bleed with collapsible palette and inspector and a full-screen mode, wider data tables.
- **Load less** (#60): GrapesJS and MJML, React Flow and ECharts in their own chunks, so sign-in and lists stay light.
- **Server-side filters and aggregates** (#55): consent summary in `profiles.list`, filters and a cursor on `messages.list`, consent counts per purpose, cost and model in `ai.usage`, a read-only domain list for builders. All additive.
- **Structured editors** (#57) for experiences and purposes, which the pilot sites use. The other JSON-edited types (tracking plan, delivery policy, conversion map, audience sync, SMS and push templates) wait for a user: agents edit them over MCP, and the JSON editor is enough for the rare human edit.
- **Live stats on the journey canvas** (#58).
- **SVG logos** (#111): sanitised on upload, served under the sandbox CSP, with a PNG rendition for e-mail.
- **Prompt test runs** (#56): progress, tokens and latency per case, and resuming a run.
- **Small fixes:** drawer tabs on phones (#62), the demo greeting (#110).

Done when the approval drawer and the journey builder pass a review on a 2000 px screen and at 390 px.

## Phase 15: newsletter and lifecycle e-mail

Goal: make the platform good at what its live pilot does, owned-audience e-mail for a content site, before widening it. Each item here is something a newsletter publisher expects from Kit, Beehiiv or Buttondown.

- **Preference centre with topics** (#84): topics under a purpose, a hosted preferences page (instead of `preferences_url` pointing at unsubscribe), topic conditions in segments. It lowers unsubscribes and complaints, and gives readers a choice short of leaving.
- **Newsletter archive and web version** (#100): a "view in browser" page per issue and an optional public archive with RSS, served on the links host (`PUBLIC_LINKS_URL`) and built on the hosted pages and the brand, so it works for every self-hoster without changes to their site. Content sites want it for sharing and SEO.
- **Reusable content blocks** (#73): versioned header, footer and section blocks with parameters, used by e-mail templates. With the template-per-issue pattern, this is what keeps issues consistent and keeps agents from copying the whole layout each week.
- **Pre-send checks** (#90): broken and unsafe links, missing alt text, missing unsubscribe, size and image weight, a basic spam-word check, shown in preview and in the approval drawer. Agents write most of the content, so this check guards every send.
- **Subject A/B tests and send windows** for broadcasts: the part of #88 and #70 that a newsletter needs (A/B on a sample, the winner to the rest, open in wave 2 Phase 6) and a recipient-local send window. Message-level tests in journeys, SMS and push wait for a user.
- **Static and CSV audiences** (#83): import a list as an audience (for migrations from Kit or Mailchimp, and for one-off sends), and snapshot a rule segment at send time.
- **Two journey building blocks:** wait until a profile matches a condition (#92), and configurable entry keys for event-triggered journeys (#93). Both are small engine changes that remove workarounds.

Done when the pilot's issues are built from shared blocks, readers can choose topics, every issue has a web version, and a subject test has picked a winner.

## Phase 16: measure and report

Goal: answer "what worked" from the platform, for people and for agents. Today the answers are spread over `messages.stats`, `journeys.stats`, `experiences.results` and `ads.performance`, and the UI's campaign report still runs on fixtures.

- **A read-only metric layer** (#75): `analytics.query` over a fixed catalogue of metrics (sends, deliveries, opens, clicks, unsubscribes, conversions, revenue) by dimensions (template, broadcast, journey, segment, day), tenant-scoped in ClickHouse. This comes first: everything else in this phase reads from it.
- **A campaign object** (#65): a grouping of broadcasts, journeys, templates and experiences under one goal, with a shared UTM campaign, so results can be reported per campaign. Kept thin: a parent and a goal, not a new editor.
- **Campaign evaluation** (#66): a funnel and results per campaign, replacing the UI's fixtures.
- **Holdout groups** (#67) for journeys and campaigns, so uplift is measured and not assumed.
- **Threshold alerts** (the alerts part of #76): deliverability, signup drop and journey errors, to a webhook or an e-mail. Configurable dashboards and scheduled reports are parked: agents read the metric layer, and the UI's fixed reports cover people.

Done when one `analytics.query` call answers how the last four issues and the welcome journey did, and a journey reports uplift against its holdout.

## Phase 17: agents with bounded autonomy

Goal: move from "agents draft, people approve every change" to "agents act within limits people set", which is what the product is for. This needs the metric layer (an agent must see results to act on them) and the approval bundles from Phase 13.

It starts with a design, not code: the controls for agents get a deeper look before any autonomy is granted.

- **Agent controls, designed first** (an ADR, then the build): an inventory of every control an agent is subject to today (token scopes, roles, drafts and approvals, budgets, audience thresholds, the kill switch, rate limits, audit) and the gaps, for example:
  - limits per agent and per token, not only per workspace: send volume, recipients per send, spend, number of changes per day;
  - what an agent may see (personal data, `agentVisible` traits) as well as what it may change;
  - expiry and review of granted autonomy, so it lapses unless renewed;
  - a clear record of what each agent did on its own, with undo where an action can be undone, and a "pause this agent" control next to the workspace kill switch;
  - detecting unusual behaviour (a burst of changes, a send far larger than usual) and falling back to "propose only";
  - how this fits the parked work: progressive rollout (#102) and in-platform routines (#86).
- **Business context for agents** (the narrow part of #85): a versioned `business_context` artifact (audience, voice, offers, do's and don'ts) exposed as an MCP resource, so every connected agent starts from the same brief. Cross-conversation memory and a skills store are parked: external agents (Hermes, Claude) keep their own memory and skills, and the platform should not compete with them.
- **Autonomy modes** (#91): per workspace and per artifact type, "propose only", "act within limits" (audience size, send volume, budget, artifact types) or "act and report", with the kill switch and audit as today.
- **The campaign agent** (#64): from a goal and an approved brief, propose a campaign (segment, templates, journey or broadcasts, holdout) as one approval bundle.
- **Scheduled routines** (#86) are parked: the pilot already runs scheduled agents outside the platform. The platform's job is to make them safe (autonomy modes, read-only tokens, the metric layer). Revisit if a self-hoster has no agent runtime of their own.

Done when the agent-controls ADR is accepted, an agent turns a brief into a campaign proposal in one approval, and Hermes sends the weekly broadcast to the existing subscriber segment without a person in the loop, within limits. That is the only autonomy granted at first; more follows the ADR.

## Later, when a pilot needs it

These are sound features without a user yet. Each moves into a phase when its trigger happens.

| Issue | Trigger |
|---|---|
| Overlay experiences: banners, popups, slide-ins (#79) | MartechSignal phase B (a newsletter slide-in tailored to the category being read). Experiences already have triggers and HTML variants, so this is templates and frequency caps on top |
| Hosted landing pages (#95) | A pilot without its own site or CMS |
| Multi-language campaigns (#74) | A pilot that sends in more than one language |
| Computed traits (#82), lead scoring and lifecycle stages (#94) | A B2B or lead-gen pilot. Segments with event counts cover engagement tiers for now |
| Business objects (#81), product catalogue and recommendations (#71), vouchers (#72) | An e-commerce pilot. Shopify import is the first step and exists |
| Message-level A/B tests beyond broadcast subjects (#88) | A journey or SMS volume where a test can reach significance |
| Per-campaign message limits (#89), cross-channel fallback (#99) | A pilot that sends on more than one channel. The workspace delivery policy covers one channel |
| Marketing calendar (#78) | Several people planning campaigns together. Needs the campaign object (Phase 16) first |
| Deliverability operations: provider breakdown, bounce taxonomy, warm-up (#98) | Volume above what the provider dashboards (Brevo, Postmark) already show, or a dedicated IP |
| Optimal send time (#68) | An audience large enough to learn from. Send windows (Phase 15) cover the pilot |
| Surveys and NPS (#77) | A pilot asking for it. Forms with extra fields and a journey cover simple cases |
| Two-way SMS keywords and conversations (#80) | A pilot that sends SMS. STOP, START and HELP already work |
| Branded short links (#101) | SMS at volume, where link length costs money. E-mail links already redirect through the links host |

## Parked: not now

These stay open, and some are wanted eventually. They are parked because they are large, carry a heavy privacy or operations load, or overlap with a specialised tool the platform can feed in the meantime. None of them is scheduled in wave 3; each says what would bring it back.

| Issue | Why not now | What brings it back |
|---|---|---|
| Session replay, heatmaps and form abandonment (#97) | A product category of its own with a heavy privacy load (recording what people type into pages). Until then, Umami, PostHog or Microsoft Clarity can do it, and the platform can receive their events | A pilot that needs replay tied to profiles and consent, which the outside tools can't give |
| Conversational inbox for e-mail, SMS and chat (#96) | A help-desk product: assignment, SLAs and a chat widget. Until then, inbound replies can go to one by webhook (or be classified with `ai.classify`) | Two-way SMS (#80) in use, or replies that need to drive journeys |
| In-app messages and a notification inbox (#87) | No pilot has an app, and the admin UI is not a customer-facing SDK. Push covers mobile | An app-based pilot |
| Feature flags and progressive rollout (#102) | Experiences already allocate traffic and hold out, and journeys pause. Autonomy modes (Phase 17) come first as the safety layer for agent changes | Agents acting with autonomy (Phase 17), where ramping a change to a cohort becomes the next guardrail |
| Predictive scores: propensity, churn, next-best-action (#69) | Needs data volume and model operations. `ai.decide` and rule segments cover next-best-action at pilot scale | The metric layer (Phase 16) in place and an audience large enough to train on |
| Configurable dashboards and scheduled reports (the dashboard part of #76) | Agents read the metric layer (Phase 16) and report in their own channels; the UI keeps fixed reports. Alerts are in Phase 16 | The metric layer in use, and people (not agents) asking for their own views |
| Cross-conversation agent memory and a skills store (the rest of #85) | External agents keep their own today; the platform supplies business context first (Phase 17) | Agents connected without a runtime of their own, e.g. the in-app copilot as the main agent |
| Scheduled agent routines (#86) | The pilot runs scheduled agents outside the platform | A self-hoster without an agent runtime, or the copilot as the main agent |

## Decisions (2026-10-26)

1. **#108 ships now, as 0.2.3**, before Phase 12.
2. **Strict inputs by default** after the evidence from #124: in the first minor release after the pilot's clients have sent no unknown keys for a week.
3. **The newsletter archive and web version live on the links host**, built on the hosted pages. An export for sites that want to build their own archive can follow if one asks.
4. **Autonomy for the pilot:** Hermes may send the weekly broadcast to the existing subscriber segment without approval, within a recipient cap, once Phase 17 lands. Everything else stays "propose only" until the agent-controls design (Phase 17) has had a deeper look.
