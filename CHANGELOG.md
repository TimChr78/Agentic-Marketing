# Changelog

All notable changes to Agentic Marketing. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, minor versions may change the commands API, the configuration and the artifact formats, and the notes say how to move.

## [0.5.2] - 2026-10-31

### Fixed

- **A paused or revoked agent stops at its next command (#275).** The executor re-reads the agent's status in every command's transaction, so a hosted run (or any principal resolved earlier) cannot keep acting after a person pauses or revokes it.
- **Undo never discards newer work (#281).** The ledger records the version the agent published; `agents.undo` refuses, with the reason, when a newer version went live since (or the artifact is no longer live), instead of republishing an older version or taking down a person's work.
- **Undoing a staged broadcast stops its stage (#287).** Like `broadcasts.cancel`, the stage becomes `stopped` with the reason, so the status no longer shows an active canary.
- **The independent check reviews the version that is published (#283).** `artifacts.requestPublish` and `requestPublishBundle` lock the artifacts before the policy decision, so a draft cannot change between the check and the publish.
- **A burst of changes caps every class (#284).** The guardian's burst response sends every change to a person instead of only holding sends, which left reversible changes unlimited.
- **Held changes that do not run are announced (#282).** When a recheck sends a held change to a person, or it first has to wait for working hours, a ledger entry (`artifacts.heldRecheck`) is recorded and the sponsor is told; it is not counted against the agent's limits.
- **The shadow report uses the approval each action created (#286).** The ledger records the approval id, so two actions on the same artifact can no longer be matched to the same decision. Shadow entries recorded before 0.5.2 show as unreviewed.
- **A restore keeps push subscriptions of erased people deleted (#280).** The erasure replay (`am restore`, #144) now deletes the person's `push_subscriptions` by their anonymous id and user id before the profiles go, as `profiles.erase` does, so a restored workspace cannot still push to a browser or app registered before the erasure. Rows in a snapshot that predates push notifications are left alone.
- **A staged send checks the whole canary, however a send window spreads it (#285).** The wait now starts at the latest canary send instead of the earliest, and a check that comes due while canary messages are still queued or held for a later opening is postponed (the stage and the run lease move) rather than judging a partial canary. `minCanary` skips the check only when the canary itself has fewer recipients, never because a delayed canary has not gone out yet.
- **Hosted agent runs count against the monthly AI budget (#274).** A run now reserves its whole `maxTokensPerRun` allowance before the model is called, so a run the budget cannot cover is refused before any call instead of starting under an arbitrary 100k reservation. Each finished run, whether it succeeded or failed, writes one `ai_calls` row with the provider, the model and the tokens it used, so `usedThisMonth`, `aiProviders.list` and the monthly budget account for hosted agents. Migration `0054_ai_call_kind_hosted.sql` adds the `hosted` AI-call kind.
- **Sponsor notifications are delivered per action, not per batch (#276).** A retry now records which actions each recipient already received, so an interleaved agent or a new action before the retry no longer changes the batch into a new idempotency key and re-sends actions someone already got. The cursor advances only past actions delivered to every recipient. Migration `0055_agent_notification_deliveries.sql`.
- **A failed daily digest for one sponsor no longer skips that sponsor for a day (#277).** The digest is tracked per sponsor through its per-day idempotency key's sent message row: a sponsor whose e-mail failed is retried on the next sweep, while the sponsors that already received the digest are not sent it again, and the daily timestamp advances only once every sponsor has it.
- **SMS and push direct sends are covered by the mandate's scope (#278).** `messages.sendSms` and `messages.sendPush` now report the published template's purpose and topic and their channel (`sms`, `push`), so a mandate limited to `channels: ['email']` refuses them instead of letting them through. They also record the message they created on the agent ledger, like `messages.sendEmail`, and the independent check now sees the SMS body and the push title, body and link, not just their ids.
- **Suppressed and failed direct sends no longer use up the daily message limit (#279).** A direct send records `people: 0` on its ledger row when the gateway answered `suppressed` or `failed` (no consent, a suppressed address, a missing or unpublished template, a delivery-policy refusal), so the agent's message counter counts only messages that went out and a blocked send does not consume `messagesPerDay`.

### Upgrading from 0.5.1

- **Migrations:** `0054_ai_call_kind_hosted.sql` (hosted runs are recorded as AI calls) and `0055_agent_notification_deliveries.sql` (sponsor notifications are tracked per action and recipient). Both additive; they run on start.
- **Configuration:** none.
- **Breaking changes:** none. Agents under a mandate are held to it more strictly: SMS and push sends are checked against its scope, a pause stops a hosted run mid-run, and `agents.undo` refuses when newer work went live.
- **Manual steps:** none. Shadow-report entries recorded before this release show as unreviewed.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.5.1] - 2026-10-31

### Fixed

- **Held changes are decided again when their veto window ends (#262).** The current mandate, the agent's counters, its guardrails and any guardian cap decide, not the terms when it was held: a stricter mandate version sends it to a person, and outside working hours it waits (it is checked again every 15 minutes) instead of running.
- **A veto cannot lose the race with the hold runner (#263).** Approving, rejecting and running a held change lock the approval (and its bundle) first, so whoever locks first decides; a hold runs at most once even with several schedulers.
- **Agent limits count what ran (#267).** Daily changes, sends and messages count actions that ran and holds still due to run; a vetoed hold no longer uses up a limit or raises the recipient-growth baseline, which is the last send that ran. A held bundle that runs is one ledger entry.
- **The independent check runs only for level-2+ actions (#260).** Drafts are no longer sent to the model, so an agent with `independentCheck` and no AI provider can still draft.
- **A mandated agent can use config.import (#268).** The import is classified as a draft; each publish in it is decided by the mandate per artifact, and bundle settings stay a person's.
- **Mandate scope covers every way to reach people (#264).** A mandate's segments, purposes, topics and channels are now checked for direct sends, journeys and audience publishes, not only broadcasts. `messages.sendEmail` reports the published template's purpose and topic and the e-mail channel; `journeys.enroll` and publishing a journey report the journey's purpose, the channels of its e-mail, SMS and push steps, and its entry and condition segments (plus its step templates' topics); publishing a segment reports its own audience, publishing an `audience_sync` its segment, and an experience touches only its own artifact because the scope's channels are delivery channels. A mandate limited to `marketing_email` on the `email` channel can therefore no longer send an `onboarding` e-mail, enrol people in a journey with SMS steps, or publish a journey for another audience.
- **The independent check sees what is published (#261).** For `artifacts.requestPublish` and `artifacts.requestPublishBundle` (and the publishes `config.import` makes) the model now gets each artifact's type, name, the version content being published and a structural diff against the version that is live, instead of only ids and the agent's note; for `messages.sendEmail` it gets the template's name, purpose, subject and MJML/text. Secrets and personal data are scrubbed, and the content goes in its own `<published-content>` block, described as untrusted, capped at 20,000 characters.
- **Mandate guardrails judge direct sends (#265).** A direct send (`messages.sendEmail`, `send.direct`) now records the message it created on the agent ledger, and the guardrail check counts the broadcasts and direct messages an agent sent in the window before computing its unsubscribe, complaint and bounce rates. A direct send that drives one of those rates above the mandate's guardrail now refuses the agent's next send with the reason instead of passing unnoticed. Journey sends are left to the journey's own holdout and alerts.
- **Agent notifications no longer replay history or drop failures (#266).** The notification cursor starts at the newest action when it is first created, so a workspace upgraded from a version before the feature is not e-mailed its historical holds and refusals (the daily digest waits a day too). The cursor now advances only past actions whose notification reached every recipient: a failed send, such as one sent before a transactional provider exists, stays pending and is retried with the same idempotency key, so the sponsor is told exactly once when it succeeds.

### Upgrading from 0.5.0

- **Migrations:** none.
- **Configuration:** none.
- **Breaking changes:** none. Agents under a mandate are held to it more strictly: held changes are decided again when their window ends, direct sends, journeys and segments are checked against the mandate's scope, and direct sends count in its guardrails.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.5.0] - 2026-10-31

### Added

- **The guardian (#253).** A scheduler job watches every active agent with a mandate and limits it by itself: a guardrail breach on its own sends (checked continuously) or rising errors cap it so every change waits for a person; a send more than 3× its usual size or a burst of changes holds its irreversible actions; probing (many refusals) or a loop (the same artifact changed again and again) pauses it. It turns the agent's pending holds into ordinary approvals, records an episode with the evidence and e-mails the sponsor and escalation targets. The policy engine applies the cap on top of the mandate and ceilings until a person clears it: `agents.guardian`, `agents.clearGuard` (people only, with a note), and a **Guardian** card on the agent page. `agents.get` shows the cap in force. Migration `0050_guardian_shadow.sql`.
- **Learning rules (#257).** A mandate's `learning` block requires holdouts on what its agent publishes: a minimum journey control group (`journeyControlPercent`, its own or its campaign's), a holdout or subject test on broadcasts (`broadcastHoldout`), and a minimum experience holdout (`experienceHoldoutPercent`). The publish impact estimate reports each member's holdout; a change without the required one goes to a person with the reason.
- **Shadow mode (#256).** A mandate with `shadow: true` (or a list of action classes) only records what it would have decided, at its granted levels even above the workspace ceiling; the action is decided as without a mandate. The ledger keeps it as `shadow` (shown in the agent's activity), and `agents.shadowReport` with the **Shadow mode** card compares it with what people did: agree, too bold, too cautious, pending or unreviewed, overall and per action class.
- **Prometheus metrics (#147).** `GET /metrics` on the main listener exposes process (uptime, memory, event-loop lag), HTTP request counts and duration by route group and status class, command executions by command/effect/outcome, queue backlog (pending messages and their age, due journey participants, due broadcast runs, warehouse exports, dead deliveries), agent ledger decisions over the last hour, and dependency health for Postgres, ClickHouse, NATS and Valkey. Labelled only with bounded values: no workspace, person or address ever appears. The endpoint is off unless `METRICS_TOKEN` is set (it then answers `404`), needs `Authorization: Bearer $METRICS_TOKEN`, and is never served on the public-only listener. `docs/deployment/operations.md#monitoring` has a scrape configuration and example alert rules.
- **`am doctor` operational checks (#147).** New live rows report a delivery queue that has not drained (oldest pending message over 15 minutes), overdue journey steps and broadcast runs, due warehouse exports, and webhook/action deliveries that ended `dead` in the last 24 hours, with the dead share of the last hour.
- **Workspace portability (#151).** `config.export` takes `includeSettings` and adds the non-secret workspace settings to the bundle: name, display time zone, approval policy, test-send seed list and agent autonomy ceilings. `config.drift` compares a bundle with the workspace and reports what would be created, updated, unchanged or conflicting without writing. A bundle with settings imports them for a person with `workspace:admin` and applies them before publishing, so `config.import` into an empty workspace clones the artifacts, their references and the settings; `scripts/am-config.mjs` gains `--settings` and `drift`. Provider credentials, API tokens, secrets, agents and people are never exported, and settings with unknown credential-shaped keys are refused.
- **Staged sends (#254).** A broadcast can send a deterministic canary share first (5–50%, default 10%), wait (PT30M–PT24H, default PT2H), and then check the canary’s bounce, complaint and unsubscribe rates against thresholds (defaults 5%, 0.3% and 2%) computed from the base counts of its message events. Above a threshold the run stops with the reason and the rest is not sent; `broadcasts.continue` (people only, `artifacts:publish`) sends the rest after someone has looked. Below `minCanary` sends the check is skipped for size. `broadcasts.status` reports the stage, the canary counts and rates, and the stop reason; the broadcast editor has a “Staged send” section and the status a “Send the rest” button. A staged send cannot be combined with a subject test. Migration 0050.
- **Hosted agents (#258, #86).** The platform can run an agent itself on a schedule. A hosted agent is an agent like any other — sponsor, status, mandate and ledger — with instructions, a schedule (`hourly`, `daily:HH:MM` or `weekly:day:HH:MM`, read in the workspace time zone), scopes (the sponsor's role ∩ the list), per-run token and tool-call budgets and an optional model provider. Each run is a fresh copilot session on the in-process MCP client as the agent principal, so every tool call passes the executor and the policy engine under the agent's mandate. Runs never overlap; each one stores its summary, tool calls, tokens and error, is e-mailed to the sponsor, and three consecutive failures disable the agent and notify the sponsor. Commands: `agents.createHosted`, `agents.updateHosted`, `agents.deleteHosted`, `agents.runHostedNow` (people only) and `agents.hostedRuns` (`artifacts:read`). **Settings → Agents → New hosted agent** prefills two templates: the read-only **weekly report** (Mondays 07:00) and the **deliverability guardian** (hourly), which proposes a pause through the normal approval and mandate path. Migration `0052_hosted_agents.sql`; the agent credential kind `hosted` marks the principal. See [docs/agents.md](docs/agents.md#hosted-agents).
- **Undo for agent actions (#255).** The agent ledger (`agent_actions`) now records how to reverse what an agent published: the version it replaced, or that it was a first publish; for a broadcast, also its scheduled send. `agents.undo` runs the reversal in one transaction — a person only, with `artifacts:publish` — republishing the previous version through the normal publish path (checks, listeners and audit apply), cancelling a broadcast that has not gone out, and marking the ledger entry undone with who did it and the result. A first publish is taken out of service again. A send that already happened cannot be recalled; the ledger says so. `agents.activity` shows whether an action is undoable, and the agent page has an **Undo** button with a note. Held changes record their reversal when the veto window ends and they actually publish. Postgres `0053_agent_undo.sql` adds the `undo`, `undone_at`, `undone_by` and `undo_result` columns; the ledger stays append-only for the app, which may only write the three undone columns.

### Fixed

- **Restores no longer resurrect erased people (#144).** `am restore` reads `erasures` and `erasure_tombstones` from the live database before replacing it and replays them afterwards: profiles and identifiers of erased people are deleted again (with their profile keys, consent, messages and journey/segment membership), suppression hashes are restored and the tombstones re-inserted. Replay is idempotent and skips workspaces the snapshot no longer has; if the log cannot be read, the restore stops. The restore reports the snapshot time, and the backup retention rule (`BACKUP_KEEP_DAYS`, the maximum age of a restore point and therefore the window in which a snapshot can predate an erasure) is documented in [Backups and restore](docs/deployment/backups.md) and [Security & privacy](docs/architecture/security-and-privacy.md).

### Upgrading from 0.4.1

- **Migrations:** `0050_guardian_shadow.sql` (agent guard, guardian episodes, shadow decisions in the ledger), `0051_staged_sends.sql` (broadcast stages, `stopped` broadcast runs), `0052_hosted_agents.sql` (hosted agents and their runs, the `hosted` credential kind), `0053_agent_undo.sql` (reversals in the ledger). All additive; they run on start.
- **Configuration:** optional `METRICS_TOKEN` (at least 16 characters) turns on `GET /metrics`; without it nothing new is exposed. Helm: put it in the chart's secret.
- **Breaking changes:** none.
- **Manual steps:** none. Mandates keep working as before; shadow mode, learning rules and staged sends are opt-in, and the guardian only acts on agents with an active mandate.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.4.1] - 2026-10-31

### Fixed

- **Mandate scope (#232).** When a mandate lists both artifact types and artifact ids, both restrict: an allowed type no longer lets a different artifact of that type through.
- **Overnight working hours (#233).** The part of an overnight window after midnight (e.g. Monday 22:00–02:00 at Tuesday 01:00) now counts to the day the window started, in the workspace time zone.
- **config.import by an agent (#239).** Each artifact it publishes is decided like `artifacts.requestPublish` (its class, reach, the audience threshold and the mandate) and recorded in the agent ledger, instead of riding on the import's own decision; an above-threshold broadcast no longer publishes directly under approval policy `none`.
- **Concurrent agent requests (#240).** The policy decision takes a per-agent lock before reading the counters, so parallel requests cannot all pass a daily limit.
- **Agent counters and held changes (#244, #245).** `agents.list`/`agents.get` count held actions (`last24h.held`), and a held change's approval note says why it was held.
- **Unknown types in config.import (#247).** A bundle with an artifact type the server does not know is invalid input instead of a server error.
- A mandate limit lowers the level by one but never below propose, which is now documented (#246).
- **Client IP behind an appending proxy (#241).** When the socket peer is a trusted proxy, a multi-value forwarding header such as `x-forwarded-for` is now walked from right to left, skipping addresses inside `TRUSTED_PROXY_CIDRS`, and the first untrusted address is used. A client can no longer prepend a spoofed address that nginx's default `proxy_add_x_forwarded_for` leaves in the leftmost position. Single-value headers (`cf-connecting-ip`, `x-real-ip`) behave as before, an untrusted peer still falls back to its socket address, and an all-trusted header still uses its leftmost address.
- **The Helm chart no longer trusts client-supplied forwarding headers by default (#236).** With `ingress.enabled=true`, the chart refuses to render while `config.TRUSTED_PROXY_CIDRS` is empty instead of accepting a client-chosen `X-Forwarded-For`. The [Kubernetes guide](docs/deployment/kubernetes.md#client-ip-behind-the-ingress) shows how to find the ingress controller's pod or node ranges and set them; CI renders the Ingress with a trusted range.
- **Egress guard:** IPv6 addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64 and 6to4) are blocked when the embedded address is private, both for literal hosts and for DNS answers at connect time (#238).
- **Outbound HTTP:** responses are aborted as soon as the byte limit is crossed and the timeout is a total deadline for the whole request in both the HTTP/1 and HTTP/2 clients, so an oversized or slowly trickled body cannot keep a request open (#234).
- **Warehouse:** the Postgres destination resolves the host once, pins the validated address for the connection and rejects mixed public/private answers, closing the DNS-rebinding gap while TLS keeps verifying the original host name (#237).
- **Public ingest and inbound webhooks refuse oversized bodies before buffering them (#235).** Both handlers now enforce their size check on the request stream, before `c.req.text()`; the inbound webhook does so before authenticating its secret URL. The limit is compared against encoded bytes, not JavaScript string length, so multibyte bodies can no longer slip past a 500 KB check at 1 MB. A chunked body without `Content-Length` is counted as it arrives and answered with 413 once it crosses the limit instead of being buffered in full.
- **Unauthenticated form, decision, preference, SMS and REST/MCP requests have request-size limits (#242).** Reusable streaming middleware now bounds `POST /f/:id` (64 KB), `POST /v1/decide` (32 KB), `POST /u/p/:token` and `/u/t/:token` (64 KB), the SMS inbound webhook (64 KB), every REST command (1 MB, except `assets.upload` with its existing larger limit) and the MCP endpoint (1 MB). Oversized requests get 413 before parsing or authentication, including bodies sent chunked without `Content-Length`.

### Security

- Two advisories in `mjml-cli`'s dependencies (`glob`, `minimatch`) are accepted with reasons in SECURITY.md: the server never loads mjml's command-line tool, and the mjml 5 upgrade (#205) removes them.

### Upgrading from 0.4.0

- **Migrations:** none.
- **Configuration:** none for Docker Compose.
- **Breaking changes:** Helm only: with `ingress.enabled=true` the chart no longer renders until `config.TRUSTED_PROXY_CIDRS` is set to the ingress controller's ranges (see the Kubernetes guide). Before, every client could choose its own address for the rate limits.
- **Manual steps:** Helm users with an Ingress set `config.TRUSTED_PROXY_CIDRS` before upgrading.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.4.0] - 2026-10-30

[Phase 18](docs/architecture/roadmap-wave-4.md#phase-18-mandates-and-the-first-autonomy) of wave 4: mandates and the first autonomy. A person can now grant an agent bounded autonomy for a purpose and a period, and the platform enforces it: within its mandate an agent can publish and send by itself (level 3), or act after a veto window (level 2), and everything outside goes to a person. The default stays a person: nothing changes until an owner raises a workspace ceiling and publishes a mandate. Works for any agent that speaks MCP or the REST API ([docs/agents.md](docs/agents.md)).

### Added

- **Mandates (#223).** A new `agent_mandate` artifact: the agent, a purpose and goals, a scope (audiences, purposes, topics, channels, artifact types or ids, a reserved brand), a level per kind of action (0 observe, 1 propose, 2 act with veto, 3 act within limits; 4 arrives later), limits (recipients per send, growth over the previous send, sends, changes and messages per 24 hours), guardrails on the agent's own sends (unsubscribe, complaint and bounce rates), working hours and blackout dates, a hold window, escalation people, an independent check, and an end date (at most a year). Only people can create, change, publish or import a mandate; publishing checks the agent, the workspace ceilings and that it is the agent's only active mandate.
- **Autonomy levels (#224).** With a mandate, the policy engine uses the lower of the mandate's level and the workspace ceiling, and lowers it further for anything outside the scope (to propose), the workspace threshold and limits (to propose), a mandate limit (one level down), a guardrail breach on the agent's recent sends (to propose), and sends outside working hours (to a hold). Settings, destructive changes, consent, purposes, delivery caps, tracking and mandates always need a person. At level 3 a publish runs without the approval policy. The ledger records the mandate version and the agent's intent (its review note).
- **Holds (#225).** A level-2 publish answers `on_hold` with `runsAt`: it publishes when the veto window ends, after re-checking that the agent is active, the workspace lets agents act and the mandate still applies; otherwise it becomes an ordinary approval with the reason. The approvals inbox shows held changes with a countdown, Run now and Veto.
- **The independent check (#231).** A mandate can ask a second model, through the workspace's AI providers and budget, whether an autonomous or held action matches the agent's intent and stays within the mandate; input from outside the workspace is treated as untrusted. A mismatch, a missing provider, an exhausted budget or an unreadable answer sends the action to a person. Logged as AI call kind `check`.
- **Notifications (#226).** The sponsor and the mandate's escalation people get one e-mail per agent per run for held, escalated and refused actions, a daily digest per sponsor, and a notice three days before a mandate expires.
- **Business context (#227).** A `business_context` artifact (what the business offers, to whom, the voice, claims to avoid, legal lines), readable as `workspace.businessContext` and the MCP resource `business-context://current`; the agent instructions tell agents to read it first.
- **Admin UI (#228).** A structured mandate editor with the ceilings shown per level, the mandate on the agent page with its expiry, intents and mandate versions in the agent activity, and holds in the approvals inbox.
- **Any agent runtime (#229).** [docs/agents.md](docs/agents.md): connecting any MCP client or REST client, the limits, mandates and levels, what an agent sees when held or refused, and mandate templates by role (newsletter agent, deliverability guardian, reporting agent, campaign drafter). The MCP skill explains working under a mandate.

### Upgrading from 0.3.0

- **Migrations:** Postgres `0047_mandates.sql` (the `hold` decision, mandate and intent in the ledger, hold deadlines on approvals), `0048_ai_call_kind_check.sql` (AI call kind `check`), `0049_agent_notifications.sql` (notification and digest state).
- **Configuration:** none.
- **Breaking changes:** none. Agents without a mandate behave as in 0.3.0. `artifacts.requestPublish` and `artifacts.requestPublishBundle` can now answer `status: on_hold` with `runsAt`, and `agents.activity` can show the decision `hold`; clients that switch on `status` should accept the new value.
- **Manual steps:** none. To let an agent act on its own, raise the workspace ceiling for that kind of action (Settings → Agents) and publish a mandate for it (see the templates in docs/agents.md).
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.3.0] - 2026-10-30

The start of [wave 4](docs/architecture/roadmap-wave-4.md), agentic marketing: [Phase 17](docs/architecture/roadmap-wave-4.md#phase-17-agent-controls), agent controls ([ADR-0016](docs/architecture/adr/0016-agent-autonomy-model.md)). Agents become principals a person can see, limit and stop, and every agent write passes one policy decision. No new autonomy yet: agents still propose as before, under the workspace approval policy, with new limits on top.

### Added

- **Agents (#213).** Every API token and connected MCP client acts as an agent, created on first use with the person who created or connected it as sponsor. `agents.list`, `agents.get`, `agents.update`, `agents.pause`, `agents.resume`, `agents.revoke`; Settings → Agents in the admin UI. Pausing refuses every credential of the agent from the next request (with the reason) and holds its pending approvals until it is resumed.
- **Autonomy settings (#215).** `workspace.autonomy` / `workspace.setAutonomy`: an autonomy switch (on, propose only, off), an audience threshold (1,000 by default), per-agent limits per 24 hours (500 changes, 1,000 direct messages), and the highest level a mandate may grant per kind of action (default 1: a person decides; mandates arrive in Phase 18). A top-bar badge shows when agents are set to propose only or off.
- **The policy engine (#214, #216, #217).** Every agent write is classified by what it changes (draft, publish content, audience, broadcast send, direct send, live journey, experience, data, settings, destructive), its impact is estimated (broadcast recipients, people in a journey, enrolments, direct sends), and it is allowed, sent to a person ("ask") or refused, with reasons. A publish that goes to a person reports why in `heldBecause` and in the approval note; an action that cannot wait for a person is refused with the way out. The audience threshold and the per-agent limits apply whatever the approval policy, including `none`.
- **The action ledger (#218).** Every agent write is recorded with its decision, reasons, impact estimate and result: `agents.activity`, and the agent's page in the admin UI.

### Fixed

- **Erased people are no longer recreated by their own queued or late events (#210).** `profiles.erase` now keeps one keyed-hash tombstone per identifier (HMAC with the workspace's matching key, never the raw user id, e-mail or phone). For `ERASURE_GRACE_HOURS` (24 by default, configurable) after an erasure, an event that names only erased identifiers and happened before that window is dropped instead of creating a new profile, covering events already on the bus, SDK retries, offline queues and late provider webhooks. After the window, new activity creates a new person as before; the hourly retention job removes tombstones once the window plus seven days has passed. Migration `0046` adds the table.

- **Analytics:** campaign ratio measures now always select the base columns they name, like the other measures (#209).

### Changed

- **Release provenance (#182).** A release now publishes SLSA build provenance attestations for the image and for the release files (Compose bundle, Helm chart, `SHA256SUMS`), and the image carries an SBOM; [Operations](docs/deployment/operations.md#verifying-a-release) shows how to check them with `gh attestation verify`.

### Upgrading from 0.2.10

- **Migrations:** Postgres `0045_agents.sql` (agents, their credentials, the action ledger, workspace autonomy settings) and `0046_erasure_tombstones.sql`.
- **Configuration:** `ERASURE_GRACE_HOURS` (optional, default 24).
- **Breaking changes:** none for people. Agents work as before under the defaults, with two new limits: an agent action reaching more than 1,000 people now waits for a person even under approval policy `none`, and an agent is limited to 500 changes and 1,000 direct messages per 24 hours. Change them in Settings → Agents.
- **Manual steps:** none. Existing tokens and MCP clients appear under Settings → Agents after their next request.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.10] - 2026-10-30

A hygiene release ([#179](https://github.com/TimChr78/Agentic-Marketing/issues/179)): bug fixes, a faster and stricter build, releases gated on CI, and documentation that matches what ships. No new features. REST and MCP stay backwards compatible. One Postgres migration runs at start-up.

### Fixed

- **Journeys: finishing at an Exit step counts as completed (#169).** It was stored as `exited`, like leaving early, so `journeys.stats` and the builder showed 0 completed for any journey that ends in an Exit step. `exited` now means leaving early (consent withdrawn, dropped in a version migration), which always records a reason. Migration `0044` relabels people who finished at an Exit step before this release; their past journey events in ClickHouse keep the old type, so `journey.completed` and `journey.exited` in the metric layer count them under `exited` for dates before the upgrade.
- **An erased person is no longer recreated by a segment event still in flight.** When someone left or entered a segment just before being erased, the platform's own "Segment Exited/Entered" event could be processed after the erasure and create a new profile from their user id (which a warehouse export then copied). Platform events now never create a profile; the person's own later activity still does.
- **Reads no longer fail when they race to create a data key.** A read such as `profiles.find` on a workspace whose matching key did not exist yet could return a 500 ("could not serialize access") when another request created the key at the same moment; the read now runs again in a fresh snapshot.
- **Metric layer: "the last four issues" really are the latest.** A `broadcast` breakdown without an explicit `order` was meant to list the newest issue first but sorted by broadcast id, so `limit: 4` could return older issues; a `journey_step` breakdown now follows journey order instead of node id. The metric catalogue also lists `campaign` as a source for the day, week and month breakdowns it supports.
- **Alerts:** a malformed window (e.g. `PT25H30M`) returns a field-level validation error naming the problem instead of a bare one, and the same members in a different order are recognised as one e-mail channel.
- **Security headers (#178).** Every response now has `X-Content-Type-Options: nosniff`, a referrer policy, `X-Frame-Options: DENY` (and `frame-ancestors 'none'` on the admin UI, so approvals cannot be clickjacked) and a `Permissions-Policy`; HSTS when `PUBLIC_URL` is HTTPS. Hosted pages, the archive and assets keep their stricter policies.
- **Dependencies (#177).** nodemailer 10.3.1 (address-parser advisories); happy-dom 21 in test tooling. The two mjml 4 advisories without a patched 4.x are unreachable with our compile options; tests guard that, and `SECURITY.md` lists them.
- **Admin UI:** list items that had no React key or an index key that could reuse the wrong row's state on removal or reordering (approval diffs, token history, breadcrumbs, consent ledger, draft warnings, preview metadata); ARIA fixes in the search palette and badges (#176).

### Changed

- **Releases run the full CI first (#170).** The release workflow calls CI on the tagged commit (lint, typecheck, audit, tests, e2e, image smoke test, chart) and publishes only if it passes; a manual release must start from main.
- **CI (#174):** a fast static job, dependency review on pull requests, timeouts, a read-only token, superseded PR runs cancelled, docs-only PRs skip the slow jobs, test results (JUnit) and a coverage report attached to each run, actions pinned to commit SHAs, Dependabot for npm, Actions and Docker.
- **Tests (#172, #173):** server test files run in parallel from a migrated template database; `pnpm test:ci`, `pnpm test:clean`; unit tests for the analytics, campaigns, alerts and audience packages; several timing races in tests fixed.
- **Lint (#176):** Biome covers the whole repository, including the admin UI, e2e and scripts.
- **Versions (#175):** `scripts/check-versions.mjs` checks all 11 places that name the release version; `@agentic-marketing/sdk-js` is marked private (it is bundled into the server, not published).
- `SECURITY.md`: private vulnerability reporting is enabled on the repository, and accepted dependency advisories are listed with their reasons (#181).

### Docs

- README, `apps/web/README.md`, the package maps, the Compose guide, the architecture pages, the analytics page, the pilot runbook and both agent skills brought up to 0.2.9 (#160–#168). The MCP skill's tool catalog is generated from the command registry (182 commands) and a test keeps it in sync.

### Upgrading from 0.2.9

- **Migrations:** Postgres `0044_journey_exit_step_completed.sql` (relabels finished participants; no schema change).
- **Configuration:** none.
- **Breaking changes:** none. Reports that read `exited` as "finished" now see those people under `completed`.
- **Manual steps:** if a proxy in front already sets `X-Frame-Options`, HSTS or a referrer policy, make it replace the app's header rather than add a second one.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.9] - 2026-10-27

[Phase 16](docs/architecture/roadmap-wave-3.md#phase-16-measure-and-report): answer "what worked" from the platform, for people and for agents. A read-only metric layer answers questions in one call; campaigns group the work under a goal and report it; control groups measure uplift instead of assuming it; and alerts say when deliverability, signups or journeys go wrong. REST and MCP stay backwards compatible: new commands and artifact types only. Two Postgres and two ClickHouse migrations run at start-up.

### Added

- **A read-only metric layer (#75).** `analytics.query` over a fixed catalogue of measures (e-mail sent, delivered, bounced, complained, opened, clicked, unsubscribed and their rates; journey entered, completed, exited, goal reached, failed; conversions; revenue per currency; segment size) by dimensions (day, week, month in the workspace time zone; channel, template, broadcast, journey, journey step, purpose, subject-test variant, message type, segment, campaign). No SQL or table names as input: every query is built from the catalogue with parameters, scoped to the caller's workspace, and rows about fewer than 5 people are hidden in breakdowns. E-mail measures count distinct people. Named reports `analytics.emailPerformance` and `analytics.journeyFunnel`; `analytics.metrics.list` lists the catalogue; Insights → Analytics shows the same numbers. "How did the last four issues do" is one call (`dimensions: ['broadcast']`, newest first, `limit: 4`).
- **Campaigns (#65).** A `campaign` artifact groups broadcasts, journeys, templates, experiences, forms and segments under a goal (conversion, revenue, engagement, signups) with an attribution window and a shared `utmCampaign`, which templates that tag their links inherit unless they set their own. A sending member belongs to one published campaign, so results aren't counted twice. `campaigns.of`, `campaigns.members`, `campaigns.archive`; Build → Campaigns.
- **Campaign evaluation (#66).** `analytics.campaignSummary` reports recipients, delivery, clicks, unsubscribes and complaints, converters and revenue per currency (people who converted within the goal's window after their first campaign message), progress against the target, a funnel, per-member results and members' holdout results, or a readiness state before the first send. The campaign's Evaluation tab shows it.
- **Control groups (#67)** for journeys and campaigns: a fixed share (1–50%) of people is assigned to control by a stable hash, gets no messages from the journey or from any of the campaign's members, and is still measured. `journeys.holdoutResult` and `campaigns.holdoutResult` report conversions per arm, absolute and relative lift with a 95% interval (Newcombe), a sample-size check and a plain verdict, with the unsubscribe rate as a guardrail. A journey inside a campaign uses the campaign's control group; changing the share after people were assigned needs `reset`.
- **Threshold alerts (#76).** Rules for deliverability (bounce or complaint rate above a threshold, with a minimum volume), signup drops (confirmed signups against the previous window) and journey errors, evaluated every five minutes through the metric layer, notifying once when they fire and once when they resolve, to a signed webhook or by e-mail to members (aggregates only). `alerts.list/get/create/update/delete/test/history`; Insights → Alerts.

### Changed

- Conversion events carry the person's profile id (resolved when they are collected), so campaign attribution can join them to messages. Events collected before this release, or before a person was known, are not attributed.

### Upgrading from 0.2.8

- **Migrations:** Postgres `0041_holdout_assignments.sql` and `0043_alerts.sql`; ClickHouse `0005_message_events_variant.sql` and `0006_events_profile_id.sql`. All additive.
- **Configuration:** none.
- **Breaking changes:** none.
- **Manual steps:** none. Campaigns, control groups and alerts are opt-in; campaign revenue and conversions count events from this release on.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.8] - 2026-10-27

[Phase 15](docs/architecture/roadmap-wave-3.md#phase-15-newsletter-and-lifecycle-e-mail): what a newsletter publisher expects from Kit, Beehiiv or Buttondown. Issues are built from shared blocks and checked before they go out; readers choose topics; every issue has a web version and can be published to an archive with RSS; subject lines can be tested; audiences can be fixed lists; and journeys can wait for a condition. REST and MCP stay backwards compatible: new commands, new optional fields and new template variables. Five migrations run at start-up, and one new public path (`/n`) needs a proxy rule where proxies filter paths.

### Added

- **Reusable e-mail blocks (#73).** A new `email_block` artifact holds an MJML fragment with typed parameters (text, url, image, color, html); templates include its published version with `{% block 'blk_…', title: 'This week' %}`. Text parameters are escaped, html ones inserted raw; required and URL parameters are checked. A template can publish only with published blocks, and `artifacts.requestPublishBundle` takes a new block and its template together. `blocks.preview` and `blocks.usage` (which templates use a block); Design → Blocks in the admin UI.
- **Pre-send checks (#90).** `templates.check` lists concrete findings (blocking, warning, info) for compliance, links, images, size (Gmail clipping), personalisation and the subject line; blocking ones (no unsubscribe link, a `javascript:` link, a missing asset) refuse publishing. Link reachability is checked on request only, through the egress guard, cached for an hour, and never for personalised or the platform's own links. The template preview and the approval drawer show the checks.
- **Topics and a preference centre (#84).** A purpose may define topics (e.g. `newsletter`, `product_news`); templates and broadcasts may name one. People choose topics on a branded preference centre (`preferences_url`, now `/u/p/…`); a message for a refused topic is suppressed (`topic_unsubscribed`); `topic_unsubscribe_url` leaves just that topic. Segments can use `{ topic: '<key>' }`. Every choice is recorded with its source; `topics.preferences`, `topics.set` (agents may only record an unsubscribe), topics in `purposes.list` and counts in `consent.summary`; `profiles.export` includes topic choices and history.
- **Web version and newsletter archive (#100).** `{{ web_url }}` in a template is a signed "view in browser" link that shows that e-mail to its recipient. A workspace can publish an archive on the links host at `/n/<slug>/` (Design → Brand → Newsletter archive): an index, one page per sent issue (rendered without anyone's personal data, with Open Graph and JSON-LD), RSS and a sitemap. Broadcasts opt in with `archive: { publish: true }`; `archive.issues` lists them.
- **Subject line tests (#88).** A broadcast's `subjectTest` sends 2–4 subjects to a sample (10–50%), then the winning subject to everyone else after `decideAfter`, chosen by clicks (default) or opens; ties and samples under 20 per variant fall back to the first subject. `broadcasts.status` shows the variants and the winner; `messages.stats` filters by variant.
- **Send windows (#70).** A broadcast's `sendWindow` (e.g. 09:00–17:00 on weekdays) holds each message until the window opens in the reader's time zone, and skips readers beyond `maxDelay` (`outside_send_window`).
- **Static lists and snapshots (#83).** Segments have a `mode`: `dynamic` (as before), `static` (people added by hand, by id or e-mail, or by CSV import with per-row results and history) or `snapshot` (a frozen copy of another segment, changed only by `audiences.refreshSnapshot`). Membership is not consent: sends still check it. Commands `audiences.add`, `.remove`, `.import`, `.imports`, `.snapshot`, `.refreshSnapshot`.
- **Wait until (#92).** A journey step `waitUntil` holds a person until a segment condition matches, checked on their events and segment changes (with a recheck and a timeout up to 90 days), and continues on matched or timeout.
- **Entry keys (#93).** An event trigger can enter people once per business key (e.g. `order_id`) instead of once per event, with `onMissing` skip or fallback; `journeys.stats` counts skipped duplicates.

### Changed

- **A registry guard:** registering a second content or publish check for the same artifact type now fails at start-up. Two Phase 15 features each registered the e-mail template's publish check, and the second silently replaced the first.

### Upgrading from 0.2.7

- **Migrations:** `0035_topic_preferences.sql`, `0036_archive_slugs.sql`, `0037_subject_tests.sql`, `0038_static_audiences.sql` and `0039_journey_wait_until_entry_keys.sql` (new tables, columns and indexes, and one function). Existing templates, broadcasts, segments and journeys behave as before until they use the new options.
- **Configuration:** none.
- **Breaking changes:** none. `preferences_url` now opens the preference centre instead of the unsubscribe link (the one-click unsubscribe link and `List-Unsubscribe` headers are unchanged).
- **Manual steps:** if a proxy or tunnel lets through only some public paths (a path rule), add `n` for the web version and the archive, e.g. `^/(f|u|c|a|n|hooks)(/[^/.%][^/%]*)+/?$`. The public-only listener (`PUBLIC_PORT`) needs nothing. Nothing else is needed; topics, the archive, blocks and tests are opt-in.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.7] - 2026-10-27

[Phase 14](docs/architecture/roadmap-wave-3.md#phase-14-admin-ui-for-daily-use): the screens used every week are quick and roomy. Pages use the window, the journey builder gets the space (with full screen and live stats), lists load a third less, lists filter on the server, experiences and purposes get real editors, and SVG logos work. REST and MCP stay backwards compatible: new commands, new optional inputs and new output fields. One migration runs at start-up.

### Added

- **Live stats on the journey canvas (#58):** "Show stats" on a published journey puts "passed N · waiting M" on each step, refreshed every 30 seconds.
- **Structured editors for experiences and purposes (#57):** placement, trigger, targeting, variants with weights, holdout, goal and analysis for experiences; key, basis, channels, double opt-in and the legitimate-interest record for purposes. The JSON stays one tab away, in sync. Keys of purposes in force are locked.
- **Prompt test runs show their progress (#56):** every case with its status, latency and tokens, totals per run, and `prompts.testRuns` lists runs, so the Tests tab resumes a run still in progress. The prompt editor sets `cache`.
- **SVG logos (#111):** `assets.upload` accepts SVG. It is cleaned against an allow-list (no scripts, event handlers, external references, `foreignObject`, DOCTYPE or `@import`, and every `url()` must point inside the file); the upload says what was removed. SVGs are served under the sandbox CSP, and a PNG rendition at 2× is made for e-mail, which uses it automatically (most e-mail clients don't show SVG); hosted pages use the SVG.
- **Server-side filters and aggregates (#55):** `profiles.list` returns each person's current consent per purpose and, with `profiles:pii`, their e-mail; `messages.list` filters by channel, status, purpose and time, with a cursor; `consent.summary` counts people per purpose and status; `ai.usage` adds the model and an estimated cost; `sendingDomains.list` shows SPF, DKIM and DMARC of the sending domains to builders (no provider details); `purposes.list` returns `requiresDoubleOptIn`. The People, Messages, Consent, Purposes, AI usage and Deliverability pages use them.

### Changed

- **The admin UI uses the window (#114):** page widths are three tokens (reading, default, full) instead of a 1280 px cap. Data pages widen to 1600 px, settings stay at a readable width, and editors are full width; nothing changes below 1280 px. The journey builder is full-bleed, with collapsible palette and inspector, a full-screen mode (`F`, `Esc`) and a smaller minimap.
- **Lists load less (#60):** React Flow loads only with a journey graph and ECharts only with a chart; the Approvals list loads 36% less (171 → 109 kB gzipped), and sign-in and the lists load none of GrapesJS, MJML, React Flow or ECharts. A CI check keeps it so.
- **`ai.usage` has a row per day, kind and model** (it was per day and kind). Clients adding up rows are unaffected; clients expecting one row per day and kind should group by those.
- The approvals badge counts a bundle once, like the list.

### Fixed

- **#62 — drawer tabs on phones:** short labels ("Changes") and a fade where the row scrolls.
- **#110 — the demo greeting** uses the demo persona's name and the visitor's time of day.

### Upgrading from 0.2.6

- **Migrations:** `0034_asset_renditions.sql` (PNG renditions of SVG assets, and `image/svg+xml` as an asset type).
- **Configuration:** none.
- **Breaking changes:** none. `ai.usage` returns more rows (one per model).
- **Manual steps:** none. To use an SVG logo, upload it in Design → Assets and pick it in Design → Brand.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.6] - 2026-10-27

[Phase 13](docs/architecture/roadmap-wave-3.md#phase-13-pilot-correctness): the pilot's weekly loop without workarounds. A weekly issue is one review instead of two, confirmations retry in seconds, looking at a journey no longer creates a draft, and unknown input keys are recorded per client. Plus the two leftovers from Phase 12. REST and MCP stay backwards compatible: new commands and new output fields only. Five migrations run at start-up.

### Added

- **Approval bundles (#107).** `artifacts.requestPublishBundle {artifactIds, note}` submits artifacts that depend on each other (this week's e-mail template and the broadcast that sends it, a form and its confirmation template) for one review. References between them are checked as if they were published; approving any of them publishes all in dependency order in one transaction, and rejecting rejects all. The Approvals page shows a bundle as one row ("+ 1 reviewed together"), and the drawer shows its members, previews the broadcast with the template under review and sends a test of it. `approvals.list` and `approvals.get` return `bundle` (its members in publish order), `approvals.approve` returns everything it `published`, and `broadcasts.preview` and `broadcasts.sendTest` take `templateVersion`. The MCP instructions, the broadcast type and the pilot guide describe the one-review flow.
- **Evidence for strict inputs (#124).** Unknown command-input keys are recorded per client (API token, person or OAuth client): key paths only, never values, kept 30 days. `system.inputWarnings` shows them: an agent sees its own, an admin sees all, with days since the last one and `safeToEnableStrict` after a quiet week. Settings → API tokens shows them per token, with a banner when it is safe to set `STRICT_INPUTS=true`. The evidence survives restarts and upgrades, unlike the log line (which stays).
- **Agents propose workspace settings (#106).** Agents still can't change workspace settings, but `workspace.proposeUpdate {name?, timeZone?, note}` (with `artifacts:write`) proposes the name or the time zone; an admin approves or rejects it on the Approvals page ("Time zone: UTC → Europe/Copenhagen"), and approval applies it like `workspace.update`. `workspace.proposals` lists them; a newer proposal for the same setting supersedes a pending one. Providers, tokens, secrets, members, roles and the approval policy can't be proposed.
- **`artifacts.discardDraft` (#117)** returns an artifact to its live version, also from the editor's "…" menu ("Discard draft (back to live vN)"). It refuses while a version is waiting for approval.
- **Message retries are visible (#109):** `messages.list` returns `attempts`, `nextAttemptAt` and `lastError`, shown under Insights → Messages.

### Changed

- **Fast retries for confirmations and transactional mail (#109).** A failed double opt-in confirmation was retried after about 5 minutes, while the person was looking at "check your inbox". Transactional and onboarding messages now retry after 10 s, 30 s, 1 min and 2 min; marketing keeps the slower backoff (SMS and push too).
- **Layout is not content (#117).** In the journey builder, a click no longer nudges a step (5 px drag threshold), and moving steps saves the layout without creating a version, so a live journey shows no draft after someone looked at it. Autosave says "Layout saved"; `artifacts.get` returns `layout`, and `artifacts.diff` marks position-only changes as `layoutOnly`.
- **The password step-up on API token edits is rate-limited (#61):** 5 wrong passwords in 15 minutes lock it for 15 minutes (`STEP_UP_MAX_FAILURES`, `STEP_UP_WINDOW_SECONDS`, `STEP_UP_LOCKOUT_SECONDS`), counted in Valkey; a correct password resets the count.

### Fixed

- **#118 — UTM tags in the plain-text part too.** Templates with `utm` tagged links in the HTML part only; the text part (generated or written by hand) now gets the same tags with the same rules.
- **#138 — the public listener's default host port no longer collides with the admin port.** 0.2.5's default `127.0.0.1:3210` made `docker compose up` fail on installs with `AM_PORT=3210`. The default is now `127.0.0.1:3201`, and `am doctor` fails when `PUBLIC_BIND`'s host port equals `AM_PORT`.
- **#139 — clearer output:** `am backup --list` marks 0.2.4 backups as `legacy` with an unusable ClickHouse part; a pre-upgrade backup from a database whose version is only known from its migration head is named after the newest release in that range; `am upgrade-notes` says how many releases it covers; `am smoke --cleanup` says which scopes it needs and when retention removes the test signup.

### Upgrading from 0.2.5

- **Migrations:** `0029_input_warnings.sql`, `0030_message_retries.sql`, `0031_artifact_layout.sql` (with the `discard_artifact_drafts` function), `0032_approval_bundles.sql` and `0033_workspace_proposals.sql`: new tables and columns only. The app takes its pre-upgrade backup first.
- **Configuration:** new, optional: `STEP_UP_MAX_FAILURES` (5), `STEP_UP_WINDOW_SECONDS` (900) and `STEP_UP_LOCKOUT_SECONDS` (900). The default of `PUBLIC_BIND` changes from `127.0.0.1:3210` to `127.0.0.1:3201`.
- **Breaking changes:** none.
- **Manual steps:**
  - If a tunnel or proxy on the host relies on the default host port of the public listener (`127.0.0.1:3210`), set `PUBLIC_BIND=127.0.0.1:3210` in `.env` or move it to 3201. With `PUBLIC_BIND` set, or a tunnel on a Docker network, nothing changes.
  - Agents that publish newsletters: switch the weekly template + broadcast to `artifacts.requestPublishBundle` (the MCP instructions say so; agents that read them pick it up).
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.5] - 2026-10-26

Fixes from the MartechSignal pilot's upgrade to 0.2.4 (#129–#135), the last step of [Phase 12](docs/architecture/roadmap-wave-3.md#phase-12-install-and-upgrade). **ClickHouse backups made with 0.2.4 contain no event data** (#129); take a new one after upgrading. REST and MCP stay backwards compatible: one new read-only command, `system.status`. One migration runs at start-up.

### Fixed

- **#129 — `am backup --clickhouse` wrote empty event tables (data loss on restore).** Tables with a workspace row policy (the Compose default, `CLICKHOUSE_ROW_POLICIES=required`) were read without `SQL_workspace`, so the policy returned no rows while the manifest claimed them. They are now exported once per workspace (`clickhouse/<table>/<workspace>.native`); the manifest records the rows actually written (format 2), and a backup fails when a non-empty table exports nothing. `am restore --clickhouse` refuses a 0.2.4 (format 1) backup, which would have replaced the event history with nothing; restore its Postgres part without `--clickhouse`. A test now backs up and restores with the row policies on.
- **#130 — backups:** the automatic one is named after both versions, `am-pre-upgrade-<from>-to-<to>-<time>`, and others `am-manual-…` / `am-scheduled-…`; manifests record `kind`, `fromVersion` and `toVersion`, and `am backup --list` shows them. The version a database last ran is recorded in a new `server_versions` table (for older databases it is derived from the migration head). Backup directories are created `0700` and files `0600` (they hold subscriber data). The scheduled `backup` service has its own healthcheck, `am backup --health`, instead of the web server's, which kept it "unhealthy".
- **#131 — `am doctor --env-file -`** reads the file from stdin, so the upgrade check works on a `0600` `.env` owned by root (it said "not found" because pnpm passed the flag to Node); an unreadable file now says why, with owner and mode. `am --help`, `am help`, `am version` and `am <command> --help` work without any configuration, and a configuration error prints one line ("Configuration is incomplete: …") instead of a stack trace.
- **#132 — `am doctor` false positives:** `COMPOSE_*` and `DOCKER_*` are no longer unknown; "new variables" means new since the version you come from (the `AM_VERSION` in the file, or `--from`), leaves out what Compose supplies, and lists optional ones as info; DMARC inherited from the organizational domain counts (and `p=none` warns); the public-port hint describes `PUBLIC_BIND` and `ports: !override`.
- **#133 — `am smoke`:** the provider check uses the new read-only `system.status` (version, whether enabled providers cover marketing and transactional mail, pending approvals; no addresses or secrets), so it passes with an ordinary API token; network errors say why (`connect ECONNREFUSED …`, `getaddrinfo ENOTFOUND …`); the signup check's side effects (a profile and a real confirmation e-mail) are documented, with `--cleanup` where the credentials allow erasing.
- **#134 — Compose:** the public listener's host port defaults to `127.0.0.1:3210` (3001 collides with Uptime Kuma and dashdot). The override example shows a tunnel on a Docker network without any host port (`ports: !override`), a neutral network name, and a `/backups` bind mount owned by uid 1000.
- **#135 — upgrading across releases:** `am upgrade-notes <version>` merges the upgrade notes of every release since that version; the image and the Compose bundle include `CHANGELOG.md`. `UPGRADING.md` covers skipping releases, backing up from versions without `am backup`, rolling back to releases without a bundle, and runs `am doctor` with the new image before `.env` changes. The 0.2.4 notes now say what applies when coming from 0.2.2.

### Upgrading from 0.2.4

- **Migrations:** `0028_server_versions.sql` (a small table of the versions that ran). The app takes its pre-upgrade backup first, now named `am-pre-upgrade-0.2.4-to-0.2.5-…`. Coming from 0.2.2 or older, 0.2.3's migration runs too: `am upgrade-notes 0.2.2` lists everything.
- **Configuration:** no new variables. The default of `PUBLIC_BIND` changes from `127.0.0.1:3001` to `127.0.0.1:3210`.
- **Breaking changes:** none in REST, MCP or artifacts. `am restore --clickhouse` refuses backups made by 0.2.4 (their ClickHouse part is empty).
- **Manual steps:**
  - If you relied on the default host port 3001 for the public listener (a tunnel or proxy on the host pointing at `127.0.0.1:3001`), set `PUBLIC_BIND=127.0.0.1:3001` in `.env` or move the proxy to 3210. With `PUBLIC_BIND` already set, nothing changes. A tunnel on a Docker network needs no host port: see block (a) of `compose.override.example.yaml`.
  - After upgrading, take a new ClickHouse backup (`docker compose exec app am backup --clickhouse`): 0.2.4's have no event data. If you run the scheduled `backup` service, add the `healthcheck` from block (d) of the override example.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.2.4] - 2026-10-26

Phase 12 of [wave 3](docs/architecture/roadmap-wave-3.md#phase-12-install-and-upgrade): installing, upgrading, checking and restoring the platform without a checkout or local edits. It is a patch release because everything is additive: REST and MCP stay backwards compatible (`workspace.get` gains one output field), every new setting is optional, and no migration runs. This is the first release with a Compose bundle and the fixed upgrade block below.

### Added

- **A Compose bundle on every release (#119):** `agentic-marketing-compose-<version>.tar.gz` with `docker-compose.yml`, `.env.example`, `compose.override.example.yaml` and [`UPGRADING.md`](UPGRADING.md), plus `SHA256SUMS`. Every release note now has an "Upgrading from" block in a fixed shape (migrations, configuration, breaking changes, manual steps, the one-line upgrade); the release workflow refuses notes without it.
- **`am init` (#122)** writes `.env` from the template with generated `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET` and `MASTER_KEY` (never printed, file mode 0600) and asks for the public URLs. It runs before the stack exists: `docker run --rm -it -v "$PWD:/work" -w /work --user "$(id -u):$(id -g)" ghcr.io/timchr78/agentic-marketing:<version> am init`.
- **`am doctor` (#122)** checks secrets, HTTPS for MCP, the links host, the public listener, trusted proxies, variables unknown to or new in this version (`--env-file`), Postgres and pending migrations, ClickHouse, NATS, Valkey, SPF and DMARC of the sending domains, and egress to the configured providers. It exits 1 on a failure. The configuration checks also run at start-up, as warnings.
- **`am smoke` (#122)** runs the post-upgrade checks from outside: `/healthz` on the public host, admin paths 404 there, dot-segment paths 400, assets served, `/readyz`, MCP tools for a token, an e-mail provider configured, and a form signup's 303. It prints a table (or `--json`) and exits 1 on a failure, so a script or an agent can gate on it.
- **Backups and restore (#121):** `am backup [--clickhouse]` writes a Postgres `pg_dump -Fc` (and optionally the ClickHouse tables) with a checksummed manifest of the version and migration head; `am restore <dir> --yes` verifies it and refuses a newer schema unless `--force`. The app takes a Postgres backup before it migrates (`SKIP_PRE_UPGRADE_BACKUP=true` turns it off), and `am backup --schedule` with `BACKUP_CRON` and `BACKUP_KEEP_DAYS` runs as an optional `backup` service (see the override example). The image now contains the PostgreSQL 16 client. What each store holds, and what is lost without a ClickHouse backup: [docs/deployment/backups.md](docs/deployment/backups.md).
- **The running version, everywhere (#120):** `/healthz` and `/readyz` report `version` (and `commit` for release images), MCP `serverInfo`, OpenAPI `info.version` and the copilot use the build's version instead of a hard-coded 0.2.0, the first log line names it, `workspace.get` returns `serverVersion`, and Settings → Workspace shows it. A test fails when they drift apart.
- **Release checks that catch what the pilot caught:** the Playwright tests run in CI (#59), and the release workflow runs `scripts/smoke.sh`, now including `am smoke` against both listeners, on the built image before pushing it.

### Changed

- **Compose defaults need no edits (#123):** `restart: unless-stopped` on every service; NATS (now `nats:2.15.0-alpine` with monitoring on 8222) and Valkey have healthchecks and the app waits for them; the public-only listener is always published, on `PUBLIC_BIND` (default `127.0.0.1:3001`), so enabling it only needs `PUBLIC_PORT=3001`. Site changes (tunnel networks, bind mounts, limits, the backup service) go in `compose.override.yaml`; see `compose.override.example.yaml` and [docs/deployment/compose.md](docs/deployment/compose.md).

### Fixed

- **#54 — ClickHouse time windows on servers outside UTC.** Query parameters typed `DateTime64(3)` were read in the ClickHouse server's time zone while event times are stored in UTC, so on such a server warehouse exports missed recent events, and profile event pages, experiment results and ad spend windows were shifted. Parameters are now `DateTime64(3, 'UTC')`, and a test keeps it so. The official image runs ClickHouse in UTC, so Compose and Helm installs with the defaults were not affected.

### Upgrading from 0.2.3

- **Migrations:** none from 0.2.3, so from 0.2.3 the new automatic pre-upgrade backup does not run (take one by hand after upgrading: `docker compose exec app am backup`). Coming from 0.2.2 or older, 0.2.3's migration `0027_journey_consent_exits.sql` is pending, and the pre-upgrade backup does run. Back up by hand before upgrading from a version without `am backup`: `docker compose exec -T postgres pg_dump -U am -Fc am > pre-upgrade.dump`.
- **Configuration:** new, all optional: `PUBLIC_BIND` (default `127.0.0.1:3001`, Compose only), `SKIP_PRE_UPGRADE_BACKUP` (default `false`), `BACKUP_DIR` (set to `/backups` by Compose), and for the optional backup service `BACKUP_CRON` (default `30 3 * * *`) and `BACKUP_KEEP_DAYS` (default 14). `docker-compose.yml` adds the `backups` volume and switches NATS to `nats:2.15.0-alpine` (same version, same data volume).
- **Breaking changes:** none.
- **Manual steps:**
  - If you edited `docker-compose.yml`, move those edits into `compose.override.yaml` (start from `compose.override.example.yaml`) before replacing the file. If you uncommented the public listener's port line, drop that edit: the mapping is now always there.
  - Compose now publishes the public listener's port on the host, loopback-only by default. If host port 3001 is already in use, set `PUBLIC_BIND` (e.g. `127.0.0.1:3101`) in `.env`, or `docker compose up` fails to bind it. A tunnel on another host needs `PUBLIC_BIND=0.0.0.0:3001`.
  - Optionally add the `backup` service from `compose.override.example.yaml`.
- **Upgrade:** download `agentic-marketing-compose-0.2.4.tar.gz` from the release, replace `docker-compose.yml` with its copy, set `AM_VERSION=0.2.4` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.2.4). Then `docker compose exec app am doctor`.

## [0.2.3] - 2026-10-26

A privacy fix from the MartechSignal pilot: people who unsubscribe leave the journeys they are in. REST and MCP are unchanged. One migration runs at start-up.

### Fixed

- **#108 — journeys let go of people who refuse their purpose.** Someone who unsubscribed during a journey stayed an active participant. The send gateway suppressed their next e-mail, so nothing went out wrongly, but `journeys.stats` and the builder kept counting them as waiting, and webhook, action and AI steps still ran for them. Journeys now follow the consent rule without a channel (ADR-0014, as segments do):
  - when the current status for a journey's purpose becomes a refusal (`withdrawn`, `objected` or `denied`) and the purpose's basis stops on it (consent, legitimate interest), the person's ready and waiting participants exit with the reason `consent_withdrawn: <purpose>`. This happens in the same transaction as the consent change: the one-click unsubscribe, provider unsubscribe and complaint events, `consent.record`, banner choices, SMS STOP and profile merges;
  - the journey sweeper checks the same rule before advancing anyone, so no later step runs whatever recorded the refusal;
  - contract and legal-obligation purposes (e.g. `onboarding`) never stop on a refusal, and not having consented yet (a pending double opt-in) is not a refusal: those people stay, and the gateway keeps holding their marketing messages;
  - erasure (`profiles.erase`, and the retention cleanup of unconfirmed signups) now deletes the person's journey participants as well.

### Changed

- **People who refused a journey's purpose before they entered exit at its first step** instead of walking through it with every message suppressed. Their participant shows as exited with `consent_withdrawn`, and no message is logged for them.

### Upgrading from 0.2.2

1. **Pull the release.** Set `AM_VERSION=0.2.3` and run `docker compose pull && docker compose up -d` (Helm: chart 0.2.3). No configuration changes.
2. **Migration `0027_journey_consent_exits.sql` runs at start-up.** It exits the participants of people who refused a journey's purpose before the upgrade, and adds an index on active participants per person. With `SKIP_MIGRATIONS=true`, run `cli migrate` first. Back up Postgres before upgrading.
3. **Check your journeys' numbers:** `journeys.stats` (or the builder) may show fewer people waiting and more exited than before. That is the fix: the difference is people who had unsubscribed.

## [0.2.2] - 2026-10-25

Hosted-page fixes that unblock the martechsignal.com go-live. REST and MCP stay backwards compatible: the only API change is that a form's `confirmedUrl` is now optional, and forms that set it behave as before. No migration.

### Fixed

- **#115 — the double opt-in confirm click lands on the confirmed page again (regression from 0.2.0).** The confirm page sent `form-action 'self'`, and Chromium applies `form-action` to the redirect that follows a form POST, so the 303 to a `confirmedUrl` on the site was blocked: the confirmation was recorded, but the browser stayed on the confirm page. The confirm page now adds the origin of its form's `confirmedUrl` to `form-action`; the rest of the policy is unchanged, and the unsubscribe and expired pages (which answer in place) keep `form-action 'self'`. A Playwright test now clicks the button in a real browser.
- **#112 — button text follows `accentText`.** The hosted-page stylesheet read an undefined `--accentText` instead of `--accent-text`, so the confirm and unsubscribe buttons used the body text colour (with the default colours, #111827 on #1d4ed8, 2.65:1, below WCAG AA). A test now checks that every CSS variable the pages use is declared.
- **#113 — the site name is no longer repeated under the logo.** With a logo, the header shows the logo only (its alt text still falls back to the site name); without one, it shows the site name. "Back to <site>" is unchanged.

### Changed

- **`confirmedUrl` is optional on forms.** Without it, confirming shows the branded "confirmed" page (Design → Hosted pages) on the links host with status 200, as unsubscribe already does; until now that page was only reachable through `hostedPages.preview`. New forms created in the UI leave it empty. The form editor, the pilot guide and the skills say so. The decision is recorded as D28 in [DECISIONS.md](docs/design/DECISIONS.md).

### Upgrading from 0.2.1

1. **Pull the release.** Set `AM_VERSION=0.2.2` and run `docker compose pull && docker compose up -d` (Helm: chart 0.2.2). No migration runs and no configuration changes.
2. **Nothing to change in forms.** Forms with a `confirmedUrl` on the site redirect there again. If a proxy rewrites the hosted pages' CSP as a workaround for #115, remove that rewrite. To use the branded confirmed page instead, clear `confirmedUrl` and publish the form.
3. **Check the click in a real browser** (not curl): open a fresh confirmation link, press the button and confirm that you land on the welcome page.
4. **Brand check:** the buttons now really use `accentText`. If a brand set `accentText` to a colour that only looked right by accident, review Design → Brand, which warns about low contrast.

## [0.2.1] - 2026-10-25

A focused fix from the MartechSignal pilot: people who unsubscribed stayed in consent-based segments. REST and MCP are unchanged: no command, input or output field was renamed or removed.

### Fixed

- **#103 — unsubscribed people leave consent segments (privacy).** An unsubscribe writes a channel row, `(marketing_email, 'email', withdrawn)`, next to the form's `(marketing_email, '', granted)`. The send gateway already took the newer of the two and suppressed the mail, but segment evaluation (streaming and batch) and audience syncs read only the all-channels row, so the person stayed in "Newsletter subscribers", in `broadcasts.preview` and the approval drawer's recipient count, in "Segment Entered/Exited" journey triggers and in **audience syncs to ad platforms**. There is now one rule for the current status of a purpose, in `@agentic-marketing/profiles` (`currentConsent` in JS, `consentStatusSql` in SQL), used by the send gateway (e-mail, SMS, push), segment evaluation in JS and SQL, audience syncs, outbound webhooks, journey webhook steps, AI context, ad conversions and the consent hooks:
  - for a channel, the newer of the all-channels row and that channel's row (the gateway's behaviour, unchanged);
  - without a channel (segments, audience syncs), a refusal on any channel that is at least as new as the all-channels row wins.

  The precedence is recorded in [ADR-0014](docs/architecture/adr/0014-consent-channel-precedence.md).
- **Unsubscribes update segments right away.** The one-click link and provider unsubscribe or complaint webhooks re-evaluate the person's segments immediately (with "Segment Exited" events) instead of on the next scheduled recompute.
- **Signing up again after an unsubscribe counts.** The form and import consent hook compared a new consent with the all-channels row only, so a confirmed re-signup after an unsubscribe was ignored as "unchanged". It now compares with the current status, and form confirmations and imports re-evaluate consent segments in the streaming path.
- `consent.record` returns `allowed` by the same rule (for the channel given, or across channels for `''`).

### Changed

- **#104 — MartechSignal pilot guide.** The guide now matches the running pilot: Brevo as the interim provider (it forces open and click tracking, disclosed on the site), Postmark planned for marketing with tracking off and the switch made before the forms, Cloudflare Email Service for transactional e-mail only, Hermes reaching MCP at `http://<LAN-IP>:3210/mcp` with an `amk_` token (and the plain-HTTP trade-off), `CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for` with `TRUSTED_PROXY_CIDRS`, and no Kit import for this site.

### Added

- **#53 — approvers can send themselves a test.** `templates.sendTest` and `broadcasts.sendTest` also accept `artifacts:approve` when `to` is omitted, so the only recipient is the caller. The approval drawer shows "Send me a test" to approvers. Sending to anyone else (or passing `to` at all) still needs `artifacts:write`, and agents and API tokens never get this path. Everything else about test sends is unchanged: members or seed list only, `[Test]` subject, suppressions apply, no consent written.

### Upgrading from 0.2.0

1. **Pull the release.** Set `AM_VERSION=0.2.1` and run `docker compose pull && docker compose up -d` (Helm: chart 0.2.1).
2. **Migration `0026_consent_segments_recompute`** runs on start (unless `SKIP_MIGRATIONS` is set). It changes no data except the bookkeeping of segment runs: it forgets the last run of every published segment that tests consent, directly or through another segment, so the segment scheduler recomputes them within about 30 seconds of start. People who unsubscribed before the upgrade leave those segments then, with a "Segment Exited" event; journeys that trigger on it will react. The consent ledger is untouched. To correct a segment at once, run `segments.refresh` for it.
3. **Audience syncs** remove the corrected people on their next run (if removals are on), or run `ads.syncAudience` now.
4. **Behaviour change to know about:** a channel-less consent check (segments, audience syncs, outbound webhooks with a purpose, AI context) is now stricter. A newer withdrawal or objection on any channel ends it, and a channel-specific grant does not lift an all-channels refusal. Sends on a channel follow the same rule as before. See ADR-0014.

## [0.2.0] - 2026-10-25

The UI and UX overhaul. A new admin UI built on a small design system (light and dark), a navigation that follows how people work (Build, Design, Audience, Insights, Approvals, Settings), an approval drawer that shows the actual e-mail, form, journey, segment or broadcast, a journey builder with drag and drop, an asset library, branded hosted pages, editable API tokens and provider settings, and the agent-facing API fixes from the pilot. REST and MCP command names are unchanged and existing inputs still validate: new inputs are optional and outputs only gain fields. Unknown input keys are accepted with a warning by default (see "Upgrading").

### Added

- **#34 — navigation and information architecture.** After sign-in only the real workspace: Build (journeys, broadcasts, forms, segments, experiences, AI prompts), Design (e-mail templates, assets, hosted pages, brand), Audience (people, consent, imports), Insights (messages, deliverability, journey stats, AI usage), Approvals (with a pending count) and Settings (providers, integrations and API tokens, secrets, users and roles, approval policy, purposes, workspace, preferences). Entries a role cannot use are hidden. Workspace switcher (`workspace.memberships`, new), global search over artifacts by name and type (⌘K or /), breadcrumbs, real URLs for every page. The demo moved to `/demo`, linked from the sign-in page only. Every artifact type has a detail page with content, preview, versions with diffs and authors, activity (reviews and audit log) and the publish action the policy allows.
- **#41 — approval review drawer.** `/approvals/<id>` shows the object itself: the e-mail rendered with its sample data at desktop and mobile width with subject, preheader and text part; the form's fields, consent text and URLs; the journey graph; the segment condition and its estimated size; the broadcast's template, segment, recipients now (`broadcasts.preview`) and send time. Changes against the live version, the content as JSON and the history are one tab away. The requester is shown by name ("Hermes, token of Sam Rivera", not `token:tok_…`) with their note. Approve, reject (a reason is required) and "Send me a test" in the drawer. Requests are "Not yet viewed" until their preview was opened, and batch approve only takes viewed ones. Works at 390 px. `approvals.list` returns `requester`, `artifactLatestVersion`, `artifactPublishedVersion` and `reviewUrl`, and takes an optional `artifactId`; new `approvals.get` returns the request with content, published content, diff and decision history.
- **#33 — journey builder.** Drag steps from a palette onto the canvas, or press them to add after the selected step; move steps by dragging; connect by dragging from an outcome or with the "Continues to" selects; delete steps and connections with Delete or the context menu (right-click or Shift+F10); undo and redo; steps coloured by category (trigger, message, wait, branch and goal, AI, webhook and action, exit) with a legend; incomplete steps marked; autosave; Check and Simulate panels, with the simulated path lit on the canvas.
- **#35 — asset library.** Upload PNG, JPEG, GIF, WebP and PDF (not SVG; bytes are checked) up to `ASSET_MAX_BYTES` (default 5 MB), per workspace, with alt text, search and where each asset is used. Public, cache-friendly URLs at `PUBLIC_LINKS_URL/a/<id>/<file>`. A picker in the template editor and the brand settings. Deleting an asset in use lists what would break. New commands `assets.upload`, `assets.list`, `assets.get`, `assets.update`, `assets.delete` (read: `artifacts:read`; write and delete: `artifacts:write`; only a person can delete an asset that is still in use).
- **#36 — light and dark themes and a Secrets screen.** System, light or dark, kept per person on the device and applied before the first paint. Settings → Secrets lists names with who changed them and when, and sets or rotates values without ever showing them.
- **#37 — branded hosted pages.** A workspace brand (site name and link, logo from the asset library, colours, font stack, corner radius, language and page wording) with a live preview under Design → Brand and Design → Hosted pages; a form may override parts of it. The confirm, confirmed, expired and unsubscribe pages use it and link "Back to <site>". Opening a link still never confirms or unsubscribes, and RFC 8058 one-click unsubscribe still works. New artifact type `brand`, new form field `hostedPages`, new command `hostedPages.preview`.
- **#44 — editable API tokens.** New `apiTokens.update` (humans only, `workspace:admin`) changes a token's name, scopes and expiry. Narrowing applies on the token's next request; widening (adding scopes or extending the expiry) says in plain words what the token could then do and needs the admin's password. New `apiTokens.get` returns the owner, last use and the change history; `apiTokens.list` and `create` return `ownerName`.
- **Workspace settings.** `workspace.update` (admins) changes the workspace name and time zone; dates and the send-time picker use the time zone. `workspace.get` returns `timeZone` and `permissionsExplained`.
- **Tests.** Playwright end-to-end tests for approvals, the provider form, token editing and the journey builder (`pnpm e2e`), against a seeded server (`apps/server/test/e2e/server.ts`), and unit and component tests for the UI (`vitest --project web`).

### Changed

- **#40 — provider settings.** Add provider opens a drawer: provider type, sender, use for (and which provider a use moves from), settings and credentials as named fields from the adapter's schema, a docs link, and the adapter's tracking capability up front. Validation errors appear on the field. Providers can be edited, enabled or disabled, have their webhook URL replaced, and be deleted. SMS, push and AI providers are on the same page. `emailProviders.list` returns `docsUrl` per adapter.
- **#48 — publishing words.** `artifacts.requestPublish` is described by its outcome ("Submit for review, or publish where the policy allows") and returns `reviewUrl` (the approval in the admin UI) and `next` (what happens next). The consent screen and `workspace.get` explain `artifacts:publish` the same way.
- **#49 — unknown input keys are reported.** Commands accept unknown keys with a `warnings` entry in the result and a server log line naming the key and the keys allowed. With `STRICT_INPUTS=true` they are rejected with `invalid_input`.
- **#50 — MCP output schemas.** Every MCP tool declares an `outputSchema`; `structuredContent` carries the result. The text block stays the full JSON; `MCP_TEXT_CONTENT=summary` makes it a one-line summary instead.
- **#51 — date-times with offsets.** `sendAt` and the other date-time inputs (`before` filters, import `recordedAt`) accept ISO 8601 with `Z` or an offset such as `+02:00` and are stored in UTC; a time without a zone fails with an example.
- **#45 item 4 — tool names.** `MCP_TOOL_NAME_STYLE=underscore` lists tools as `artifacts_create` for clients that reject dots. Default unchanged.
- Version authors and audit entries carry display names (`by` on versions, `actorName` and an optional `target` filter on `audit.list`, `updatedByName` on `secrets.list`).
- The admin UI no longer loads Google Fonts; it uses the system font stack.

### Upgrading from 0.1.2

1. **Pull the release.** Set `AM_VERSION=0.2.0` and run `docker compose pull && docker compose up -d` (Helm: chart 0.2.0). Migrations `0023_workspace_settings` (workspace time zone, default `UTC`), `0024_token_changes` (token history) and `0025_assets` (asset tables with row-level security) are additive and run on start unless `SKIP_MIGRATIONS` is set. Nothing is rewritten or dropped; the consent ledger is untouched.
2. **Expose `/a/` publicly.** Asset URLs live on `PUBLIC_LINKS_URL` under `/a/`. The public-only listener (`PUBLIC_PORT`) already serves it. If your tunnel uses a path rule on port 3000 instead, add `a` to it: `^/(f|u|c|a|hooks)(/[^/.%][^/%]*)+/?$`.
3. **Roll out strict inputs in two steps.** 0.2.0 starts with `STRICT_INPUTS=false`: unknown keys are accepted, logged (`command input has unknown keys`) and returned in `warnings`. Watch the logs and the agents' results for a week, fix clients that send unknown keys, then set `STRICT_INPUTS=true` so a misspelt field fails instead of being ignored.
4. **New optional settings.** `ASSET_MAX_BYTES` (default 5242880), `MCP_TEXT_CONTENT` (`json` or `summary`, default `json`), `MCP_TOOL_NAME_STYLE` (`dotted` or `underscore`, default `dotted`), `STRICT_INPUTS` (default `false`). See `.env.example`.
5. **Set the workspace time zone.** Settings → Workspace. Until you do, dates show and the send-time picker works in UTC. Stored times do not change.
6. **Set up the brand.** Design → Brand, then check Design → Hosted pages. Until a brand is published the hosted pages keep their neutral look.
7. **Bookmarks and links.** The UI has real paths now (`/build/journeys/<id>`, `/approvals/<id>`, `/settings/…`). Old `#` links open the start page. The demo is at `/demo`.
8. **Agents.** Reconnect MCP clients to pick up output schemas. Tell agents to pass `reviewUrl` on to their person after `requestPublish`. Date-times may now carry an offset.

No REST/MCP command was renamed and no existing input lost or changed a field. New commands: `approvals.get`, `apiTokens.get`, `apiTokens.update`, `workspace.update`, `workspace.memberships`, `hostedPages.preview` and `assets.*`.

## [0.1.2] - 2026-10-24

The pilot-0.1.1 follow-up: the issues found while running the MartechSignal pilot on 0.1.1. One blocker (outbound requests failed on Node 22), one security hardening, and the provider, MCP and test-send gaps the pilot ran into. REST and MCP command names are unchanged and existing inputs still validate: new inputs are optional and outputs only gain fields, so 0.1.1 clients and agents keep working.

### Fixed

- **#42 — outbound requests work on Node 20+ without a workaround (blocker).** The egress guard's DNS lookup ignored `options.all`, so `net.connect` with Happy Eyeballs (`autoSelectFamily`, the default since Node 20) got a single address where it expected a list and failed with `Invalid IP address: undefined`. E-mail and SMS providers, webhooks, connector actions, ad platforms and the push adapters were all affected. The lookup now resolves every address, refuses the whole answer if **any** address is private (a mixed public/private answer can no longer slip through), and returns the list or the first address as asked. A new test makes a real request by host name through `safeRequest` and `egressFetch` with Happy Eyeballs on, and CI is pinned to the Dockerfile's Node major so the test runs on the shipped Node.
- **#39 — the public surface cannot be turned into the admin API with dot-segments (security).** Proxies such as cloudflared match path rules against the raw path and forward it raw, so `/f/../v1/workspace.get`, `/f/%2e%2e/v1/…` and `/hooks/../mcp` passed the documented rule and reached the admin API, sign-in and MCP (still behind authentication). The server now answers 400 to any request whose raw path has `.`/`..` segments, encoded `.`, `/` or `\` (`%2e`, `%2f`, `%5c`) or a backslash, before routing. New optional **`PUBLIC_PORT`**: a second listener that serves only `/f`, `/u`, `/c` and `/hooks` (plus `/healthz` and `/readyz`) and answers 404 to everything else, so a tunnel can point at it with no path rule at all. The implementation guide and the MartechSignal pilot now use it, give the strict fallback rule `^/(f|u|c|hooks)(/[^/.%][^/%]*)+/?$`, and add a `curl --path-as-is` check.
- **#40 — e-mail provider webhook URL, reply-to and form (items 1, 2 and 6).** `emailProviders.create` returns `webhookUrl`, the full URL built from `PUBLIC_LINKS_URL`, and the UI shows that instead of the admin origin. New `emailProviders.rotateWebhook` (admins, audited) issues a new URL when the old one is lost; the old URL stops working, and the UI has a "New webhook URL" action. The provider form has a reply-to field and resets after a successful create. Choosing `useFor`, named credential fields and editing in the UI are still open in #40.
- **#43 — provider-side tracking is visible.** Every e-mail adapter declares `tracking`: `forced` (Brevo: open and click tracking on every message, including the unsubscribe link, which cannot be turned off here), `configurable` (Postmark: the platform now sends link tracking off explicitly; SES: only if the configuration set enables it) or `none` (Cloudflare Email Service, SMTP relay-dependent, log). `emailProviders.list` returns `tracking` and `trackingNote` per provider and adapter, plus `warnings` when `EMAIL_TRACK_CLICKS=false` but an enabled marketing provider tracks anyway; `create` and `update` return the same warnings. The UI shows the capability and the warning, and `docs/architecture/email-and-sms-delivery.md` lists provider-side tracking per adapter.
- **#45 — MCP guidance for agents (items 1–3).** The MCP server returns `instructions` in `initialize`: the draft → validate → `requestPublish` → person approves flow, approval rounds for dependencies, what agents cannot do, where to start, test sends and the privacy rules. The same text is the resource `agentic-marketing://guide`. `artifacts.types` takes an optional `type` and returns just that schema instead of all of them (about 66 KB); with no input it answers as before. The broadcast type now documents the template-per-issue pattern for newsletters (broadcasts carry no per-send data). Dotted tool names (item 4) are still open.

### Added

- **#46 — test sends.** `templates.sendTest` and the new `broadcasts.sendTest` send a template version, or a broadcast's latest draft with the template it would send, to up to 10 recipients through the real provider, with `[Test]` in the subject. Recipients must be workspace members or on the workspace seed list, which admins set with the new `workspace.setSeedList` (shown in `workspace.get`). Purpose and consent checks are skipped; suppressions still apply; no profile, consent or subscription is written; unsubscribe links are inert. Each copy is a message with `test: true` (in `messages.list`), is audited under its command, and is left out of reporting, frequency caps and stream health. Delivery events for test messages never change consent. Agents need `artifacts:write`, so a drafting agent can test its own drafts without being able to send to the list.

### Upgrading from 0.1.1

1. **Pull the release.** Set `AM_VERSION=0.1.2` and run `docker compose pull && docker compose up -d` (Helm: chart 0.1.2, whose migration job runs first). Migration `0022_test_sends` adds `messages.test` (default `false`) and `workspaces.seed_list` (default empty); it is additive and runs on start unless `SKIP_MIGRATIONS` is set.
2. **Remove the Node workaround.** If you added `NODE_OPTIONS=--no-network-family-autoselection` to the app container for #42, remove it: outbound requests work with Node's default Happy Eyeballs again. Leaving it in does no harm, but it disables IPv4/IPv6 fallback for every outbound connection.
3. **Move the tunnel to the public listener (recommended).** Set `PUBLIC_PORT=3001` on the app and point the public hostname (`am.<site>`) at `http://app:3001`, with no path rule and no catch-all. If cloudflared is not on the Compose network, publish the port (see the commented mapping in `docker-compose.yml`). If you keep a path rule on port 3000, replace it with `^/(f|u|c|hooks)(/[^/.%][^/%]*)+/?$` plus a catch-all to `http_status:404`. Either way, check from outside:
   ```sh
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.<site>/f/../v1/workspace.get        # 400 or 404, never 401
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.<site>/f/%2e%2e/v1/workspace.get    # 400 or 404, never 401
   ```
   Raw paths with dot-segments or encoded `.`/`/` now get 400 on both ports. Normal links, form posts, webhooks and API calls never contain them.
4. **Check provider webhook URLs.** Providers created on 0.1.1 keep their current URL. If you copied the admin-origin URL shown by the 0.1.1 UI, or no longer have the URL, use "New webhook URL" (or `emailProviders.rotateWebhook`) and register the new `PUBLIC_LINKS_URL`-based URL with the provider.
5. **Review provider tracking.** With `EMAIL_TRACK_CLICKS=false`, open E-mails → E-mail providers (or `emailProviders.list`) and act on any warning: Brevo tracks every message it sends. Postmark messages now always go out with Postmark link tracking off, because the platform does its own click tracking when `EMAIL_TRACK_CLICKS` is on.
6. **Set up test sends.** Workspace members can receive test sends with no setup. For monitoring inboxes, an admin sets `workspace.setSeedList`. `templates.sendTest` now needs `artifacts:write` instead of `messages:send`, and `to` also accepts a list. Built-in roles that had it keep it; an API token or agent scoped to `messages:send` without `artifacts:write` needs the `artifacts:write` scope.
7. **Agents:** reconnect MCP clients to get the server instructions, and use `artifacts.types` with `{ "type": "…" }` instead of loading every schema.

No REST/MCP command was renamed and no artifact, form, journey or e-mail provider input schema lost or changed a field in this release. New commands: `emailProviders.rotateWebhook`, `broadcasts.sendTest` and `workspace.setSeedList`.

## [0.1.1] - 2026-10-23

The pilot-0.1.0 follow-up: the seven issues found while preparing the MartechSignal pilot are fixed. REST and MCP command names and the input schemas for artifacts, forms and journeys are unchanged, so 0.1.0 clients keep working.

### Fixed

- **#26 — plain-HTTP LAN deployments start again.** A `PUBLIC_URL` such as `http://192.168.1.10:3210` no longer crashes the server in the MCP plugin. The admin UI and REST API work over HTTP on a LAN; the server logs a warning and leaves `/mcp` and its protected-resource metadata disabled. MCP requires HTTPS (or a loopback URL). See the [quick start](README.md#quick-start-docker).
- **#27 — the admin UI ships in the image.** `apps/web` is built in live mode and served at `/`, so `docker compose up -d` gives a working UI without a checkout or Vite dev server. `WEB_DIST` can point at a different build.
- **#28 — Compose runs the released image.** The default `docker-compose.yml` pulls `ghcr.io/timchr78/agentic-marketing:${AM_VERSION}` instead of building from source; `docker-compose.build.yml` is the explicit source-build overlay. The host port is `AM_PORT`, and ClickHouse is capped with `CLICKHOUSE_MEM_LIMIT` (default `2g`).
- **#29 — pilot documentation corrected.** The implementation guide and MartechSignal pilot now describe both public-path options consistently (A: separate `am.<site>` hostname, the default; B: `/am/*` on the site domain), document the automatic retention job instead of a manual cleanup that does not exist, and separate plain-HTTP admin URLs from HTTPS-only MCP.
- **#30 — passwords stay out of process arguments.** `cli bootstrap` reads `AM_BOOTSTRAP_PASSWORD`, prompts without echo on a TTY, or reads one stdin line. `--password` still works but is deprecated and warns. New `cli reset-password` (`AM_RESET_PASSWORD`, prompt or stdin). The image also ships an `am` wrapper that runs the CLI without pnpm's banner, and the CLI no longer prints the missing `.env` warning twice.
- **#31 — client IPs work behind two ingress paths.** `CLIENT_IP_HEADER` accepts an ordered, comma-separated list (e.g. `cf-connecting-ip,x-forwarded-for`). `TRUSTED_PROXY_CIDRS` limits which proxies may supply forwarding headers; requests from other addresses use the socket address. This keeps Cloudflare Tunnel visitor IPs and LAN admin/sign-in traffic in separate rate-limit buckets and prevents header spoofing outside the trusted proxies.
- **#32 — incomplete journey drafts can be saved.** Drafts now validate the graph structure only; unfinished e-mail, SMS, push, AI, webhook and action nodes produce warnings instead of blocking an autosave, and the builder marks the affected steps. Publishing still validates every node configuration and now reports the concrete node and field in the error message. `artifacts.create` and `artifacts.updateDraft` add a `warnings` field to their responses; their inputs are unchanged.

### Upgrading from 0.1.0

1. **Compose now pulls the release image.** Set `AM_VERSION=0.1.1` (the new default) and run `docker compose pull && docker compose up -d`. If you build from source, use `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`; `scripts/smoke.sh` uses that overlay. `AM_PORT` changes the published host port; keep `PUBLIC_URL` and `PUBLIC_LINKS_URL` in step with it.
2. **ClickHouse has a memory cap.** `CLICKHOUSE_MEM_LIMIT` defaults to `2g` for the whole container. Raise it for large imports or event volume; ClickHouse's own `max_server_memory_usage` still applies inside the cap.
3. **The admin UI is served at `/`.** No separate web container or dev server is needed. A custom build can be mounted and selected with `WEB_DIST`.
4. **Plain HTTP is admin-only.** If `PUBLIC_URL` is HTTP on a non-loopback address, the server starts with a warning and disables MCP/OAuth discovery. Move MCP to an HTTPS URL (Tailscale Serve/Funnel, Cloudflare Tunnel or a TLS reverse proxy) before connecting agents.
5. **Review the client-IP settings if you run two ingress paths.** `CLIENT_IP_HEADER=cf-connecting-ip` still works as a single value. The recommended pilot setting is `CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for` plus `TRUSTED_PROXY_CIDRS` for your tunnel/reverse-proxy ranges. Leaving `TRUSTED_PROXY_CIDRS` empty preserves the 0.1.0 behaviour of trusting forwarding headers from any source.
6. **Update bootstrap scripts.** `--password` is deprecated. Use `docker compose exec -e AM_BOOTSTRAP_PASSWORD app am bootstrap …`, a hidden prompt, or `docker compose exec -T app am bootstrap … < password.txt`. Use `am reset-password --email …` to rotate an existing password. The server CLI is `am` inside the image.
7. **Re-save unfinished journeys.** Existing drafts with empty placeholder references can now be saved and will show warnings until their steps are configured. Publishing remains blocked until they are complete.
8. **Documentation:** the retention notes in the pilot guide were stale, not the code. The scheduler has removed never-confirmed, form-only profiles after `RETENTION_UNCONFIRMED_DAYS` (default 30) and finished delivery/AI logs after `RETENTION_LOG_DAYS` (default 180) since 0.1.0.

No REST/MCP command was renamed and no artifact, form or journey input schema changed in this release.

## [0.1.0] - 2026-10-23

The first release: everything built in waves 1 and 2 of the [roadmap](docs/architecture/roadmap-wave-2.md). It is a pre-release: the features are complete and tested, but the platform has not yet run a production workload (the MartechSignal pilot is next).

### Included

- **Agent-first core:** every capability is a command, the same over REST, MCP and the web UI, under one permission model, approval policies and a hash-chained audit log. Versioned artifacts (segments, templates, journeys, forms, experiences, prompts…) with drafts, diffs and config as code.
- **Customer data:** Segment-compatible ingest and a browser SDK with a consent banner (Google Consent Mode v2), a tracking plan, bot filtering, identity resolution, a consent ledger per purpose, data export and erasure, crypto-shredding of personal data.
- **Segments:** traits, events, consent and nested segments, evaluated in Postgres and ClickHouse, load-tested to a million profiles.
- **Channels:** e-mail (SES, Postmark, Brevo, Cloudflare Email Service, SMTP; MJML and Liquid), SMS (Twilio), push (web push, FCM, APNs), all through one send gateway with lawful basis, consent, suppressions, frequency caps, quiet hours and deliverability auto-pause. Newsletter signup with double opt-in, subscriber import with consent proof, broadcasts.
- **Journeys:** a visual builder and engine with waits, branches, splits, messages on every channel, webhooks, connector actions, transforms and AI steps with fallbacks; version migration.
- **Web personalization:** a decision API (and a Cloudflare Worker for the edge), A/B tests with fixed, sequential and Bayesian statistics, a visual composer and preview links.
- **AI:** bring-your-own providers (Anthropic, OpenAI-compatible, Ollama…), budgets and metering, prompt artifacts with tests, redaction, classification, text cached per segment, sampled human review, and a streaming in-app copilot over MCP.
- **Performance marketing:** conversions to Meta, Google Ads, Microsoft Advertising, LinkedIn, TikTok and Pinterest; audience sync to Meta and Google; spend import with CPA and ROAS. Agents read and draft; budgets and bids stay with people.
- **Integrations:** signed webhooks, a connector SDK (Shopify and the Shopify app, Salesforce, Slack, HTTP, OAuth 2.0 APIs), inbound hooks, API tokens, warehouse export (Postgres, S3).
- **Operations:** one image with four roles, a Helm chart, OpenBao/Vault and AWS KMS key providers, Postgres row-level security and ClickHouse row policies per workspace, SSO (OIDC, SAML) and SCIM.

### Installing

- Docker Compose: see the [quick start](README.md#quick-start-docker).
- Kubernetes: the Helm chart attached to this release, or `deploy/helm/agentic-marketing`, with the image `ghcr.io/timchr78/agentic-marketing:0.1.0`; see the [reference deployment](docs/deployment/kubernetes.md).

### Known limitations

- Not yet run against production traffic. The ad platforms, Salesforce, Shopify, FCM and APNs adapters are tested against local stand-ins of their APIs, not the live services. Details to confirm with a real account: the LinkedIn-Version header, the Shopify webhook subscription field (`uri`), TikTok's error codes.
- SAML single sign-on is not tested end to end against a real identity provider; there is no SSO settings screen.
- Session conditions (page views, events this visit) are not available to edge decisions.
- No audiences or spend import for LinkedIn, TikTok and Pinterest; no Microsoft reporting or audiences.
- No push provider screen, notification actions or automatic re-subscription after `pushsubscriptionchange`.
- The browser SDK is not published to npm yet; build it from `packages/sdk-js` (`pnpm --filter @agentic-marketing/sdk-js build`).

The full list, with where each item lands, is in the [roadmap](docs/architecture/roadmap-wave-2.md#every-known-limitation-and-where-it-lands).
