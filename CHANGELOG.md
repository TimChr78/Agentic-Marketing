# Changelog

All notable changes to Agentic Marketing. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, minor versions may change the commands API, the configuration and the artifact formats, and the notes say how to move.

## [0.14.14] - 2026-11-13

### Fixed

- Alert evaluation commits one rule per transaction (#788): a rule whose episode or outbox write fails no longer rolls back the episodes of the rules that ran before it, and a rule's minimum interval starts only after its transaction commits, so a rolled-back decision is retried on the next tick instead of being suppressed for up to an hour. The bounded failure back-off is unchanged.
- Release runs are serialised in one queue across all lines (every waiting release is kept, not replaced by a newer one), a manual release reserves its version tag before it pushes an image, and the floating `:<major>.<minor>` image tag is pushed only when the version is the newest release in its line (#773): an older patch finishing later can no longer move the tag backwards, and an unreadable tag list publishes the exact version alone. The `latest` image tag follows the same rule across all lines: it moves only for the newest stable release, never for a prerelease or a retried older release. A newer prerelease no longer holds the stable line tag back, and a tag that is not valid SemVer is ignored.
- The Helm chart refuses to render when `config.PORT` is set and differs from the top-level `port` (#774), instead of producing a pod the probes and Service target on another port, which never passes readiness.
- The release scripts refuse a shallow clone (#772): `prepare.mjs` and `close-issues.mjs` fail with `git fetch --unshallow --tags` instead of silently truncating the tag range, which skipped issues and rendered "Migrations: none." for a release that had migrations.
- Unknown `/oauth/*` paths answer a JSON 404 instead of the admin SPA shell, `/metrics` is in the API path list, and the `/hooks`, `/oauth` and `/scim` JSON catch-alls are registered on every server role (#751), so an api-only or ingest-only pod answers JSON too.
- `/scim` traffic is counted in the `api` route group and `/oauth` gets its own `oauth` group (#752), so an identity-provider outage no longer pages as an admin-UI regression; the group table in the metrics documentation is updated.
- The backup documentation no longer says the scheduler does not verify its own backups (#783): since 0.14.3 it runs the read-back check after every scheduled backup, so the heartbeat and the verification age are real without a second container or host cron entry.
- The architecture status pages are version surfaces again (#784): `prepare.mjs` bumps their release line and `check-versions.mjs` checks it, so they cannot pin an old release between releases. Prerelease versions (`1.0.0-rc.1`) are read back too. The release checks also require `docs/status/current.md` to call the version released in its "Now" section and to name it as the last release.
- The release gates require `docs/status/current.md` to name the release being cut as released (#785): `prepare.mjs --check` and `check-notes.mjs` fail while the handoff still says it is in progress.

### Upgrading from 0.14.13

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** the Helm chart refuses to render when `config.PORT` is set and differs from `port` (remove `config.PORT` and set `port`); unknown `/oauth/*` paths answer a JSON 404 instead of the admin app; the metrics `route_group` label counts `/scim` as `api` and `/oauth` as a new `oauth` group, so dashboards or alerts keyed on `ui` for those paths need updating.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.14.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.14 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.14` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.14). Run `docker compose exec app am doctor`.

<!-- issues: 751, 752, 772, 773, 774, 783, 784, 785, 788 -->

## [0.14.13] - 2026-11-13

### Fixed

- The broadcast composer re-reads its template and segment, and re-runs the evidence and audience estimate, when the window regains focus: a template or segment republished by another tab, person or agent no longer leaves "Live vN · Ready" evidence describing an older send.
- An artifact change now names the artifact it changed, so saving a broadcast no longer forces the composer to re-read its template and segment or flips both evidence rows to "Checking"; the explicit "Refresh checks" still bypasses the cache.
- Reference pills such as "Live vN" in a form or broadcast preview, and the shared artifact-name lookup, update after an in-tab publish or rename instead of staying on the pointer they first read.
- Segment estimates track the membership of referenced static lists and snapshots: `segments.preview` reports a list's membership stamp and the editor turns a count into a previous estimate after an import, even though the list's published version did not move. If a referenced segment cannot be re-checked (for example after access to it is removed), the estimate is shown as possibly out of date instead of current. The referenced segments' versions and stamps are only returned to callers with `artifacts:read`; a caller with only `profiles:read` still gets the count.
- **Breaking:** `segments.ofProfile` and `topics.preferences` no longer expose artifact ids and names to a token that has `profiles:read` without `artifacts:read`: both return no entries and set `withheld: true`. A caller with `artifacts:read` sees the same output as before.
- A malformed percent escape in a route parameter (`/artifacts/%`) keeps the raw segment and shows the page's recoverable error, and a root error boundary replaces a blank page with a retryable error when a route throws.
- Starter "Check prerequisites" and "Create drafts" results are sequenced like the detail read: a slower earlier starter can no longer show its prerequisites, draft list or created artifacts under the newly selected starter.
- `templates.check` with `checkLinks: true` no longer fails with `invalid_input` on a template whose footer is a reusable block: the link-personalisation probe renders with the same block resolver as the main render, and a probe that still cannot render treats every link as personalised instead of failing the check (#782).
- E-mail link rewriting decodes an href's character references once before it becomes a URL, so `&#38;`, `&#x26;` and `&amp;` all keep the query parameters after them instead of turning into a `#38;` fragment; tagging and click tracking write the value back with `&amp;` and sign the same decoded URL the unsubscribe check sees (#789).
- A form's allowed origin drops the scheme's default port (`:443` for https, `:80` for http) on save and on comparison, so `https://MySite.com:443` accepts the `https://mysite.com` Origin a browser sends; a non-default port such as `:8443` is kept (#769). IDN hosts are not involved: the origin schema already rejects non-ASCII hosts.

### Upgrading from 0.14.12

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** a token with `profiles:read` but without `artifacts:read` gets `{ segments: [], withheld: true }` from `segments.ofProfile` and `{ topics: [], withheld: true }` from `topics.preferences`, and `segments.preview` no longer lists the referenced segments' versions and stamps for it; grant `artifacts:read` to keep the details.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.13.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.13 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.13` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.13). Run `docker compose exec app am doctor`.

<!-- issues: 767, 768, 769, 770, 771, 782, 789, 791, 792 -->

## [0.14.12] - 2026-11-13

### Fixed

- Experiment results count exposure and conversion only for the version they describe. A republished experience whose variants were renamed no longer returns rows for the old variant ids, loses its control fallback or claims "Nothing to compare yet" under the new version's number (#758).
- The results screen prints the version the server measured and the analysis settings of that version, so an open draft with a different `alpha`, `threshold` or method no longer rewrites the caption of a result computed from the published version; a version too new to have exposures says "No data for version N yet" (#758, #759).
- Experiment results no longer leave exposures recorded without a version silently out of the counts: when the window holds any, the note says how many were excluded and that results count only the version they describe (#758).
- The journey holdout card labels the absolute lift and its 95% interval in percentage points ("+5.0 pp"), like the campaign and broadcast holdout panels, instead of printing a rate-style percent (#794).
- The Messages list loads the workspace's purposes and names a message's custom purpose; it no longer shows "Unavailable purpose" for every purpose an operator defined themselves (#793).
- `campaign.converters` and `campaign.conversion_rate` are a campaign total again: currency partitions only the revenue roll, so requesting `campaign.revenue` (or `campaign.revenue_per_recipient`) no longer splits converters per conversion currency or divides a per-currency count by the all-channel recipients. The same campaign now reports the same converter count and rate with and without a revenue measure.
- `ads.performance` reads conversion events through the paged reader keyed by the table's full replacing key, so a report window with more than 100,000 conversions counts every event instead of an arbitrary 100,000-row slice, and two conversions that tie on timestamp and event id are both counted. Each page is folded into the totals before the next is read, and the last `utm_campaign` touch is now chosen in ClickHouse per conversion within its window (the conversion chunk is the join's build side and touches stream past it), so the response is at most one row per conversion and neither the server nor ClickHouse holds a visitor's touch history, however long; a report counts its touch and conversion pairs before joining them and fails with a clear message, never partial totals, past 10 million pairs per batch, 50 million per report or 25 seconds per query (a ClickHouse or client timeout reports the same clear error); conversion tuples are chunked below ClickHouse's HTTP form-field limit, so a window whose conversions have more than 100,000 distinct anonymous ids succeeds instead of failing with “Field value too long”. A same-time touch tie is resolved deterministically by event id.
- Campaign-source freshness is scoped to `sent` and `delivered`, the events the recipient count reads, so a later `failed`, `queued` or `skipped` send decision cannot become the “latest event in period”; an empty match now returns null rather than 1970-01-01.
- `analytics.campaignSummary` includes an archived campaign when it is requested by id, so its headline, funnel and revenue describe the same members as its member rows instead of a zero headline beside populated rows.

- After upgrading, expect these numbers to change: `campaign.converters` and `campaign.conversion_rate` rise to the campaign total on every per-currency row (for example DKK/EUR rows that reported 2 and 1 converters and rates 0.2/0.1 for a 10-recipient campaign now both report 3 converters and 0.3); `ads.performance` conversions, revenue, CPA and ROAS can rise for windows above 100,000 conversion events; campaign freshness moves back to the last `sent`/`delivered` event for SMS- or push-only campaigns; and an archived campaign’s summary headline becomes non-zero and matches its member rows.

### Upgrading from 0.14.11

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** `ads.performance` refuses, with `precondition_failed` and no partial totals, a report whose last-touch attribution would compare more than 10 million campaign touches with conversions in one batch (50 million per report) or take longer than 25 seconds; narrow the date range or the attribution window. `campaign.converters` and `campaign.conversion_rate` change to campaign totals (see the note above), and experiment results count only the version they describe.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.12.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.12 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.12` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.12). Run `docker compose exec app am doctor`.

<!-- issues: 758, 759, 760, 779, 780, 786, 793, 794 -->

## [0.14.11] - 2026-11-13

### Fixed

- Connector webhooks (Shopify, Salesforce and a generic mapping) no longer run the workspace tracking plan, so a strict plan cannot silently drop a mapped order or record while the sender is told the delivery succeeded. Senders see no status-code change: accepted deliveries still answer 200, and a replay is still a 200 that says nothing new was ingested.
- Replay protection now covers every inbound connection, not only Standard Webhooks. A byte-identical body on an `hmac-sha256` or unsigned generic webhook is answered as already received and publishes nothing; a different body publishes again. Those schemes carry no timestamp, so the dedupe window is the hot-state TTL (10 minutes). The identity is the body plus the values of the headers the mapping read when it ran, however the expression reached them: a header it never reads (an extra header on a replayed signed body, a provider's per-attempt signature or timestamp) does not count, and deliveries whose mapped events differ because of a header never share an identity. If a mapping's choice of which headers to read depends on the clock or randomness, an identical retry may publish twice (never lose an event); Standard Webhooks, whose signed `webhook-id` is the replay key, avoids that. The Shopify topic is always part of the identity, so an order delivered as both `orders/create` and `orders/paid` records both.
- A hard bounce or complaint that arrives while an SMS STOP suppression already holds the number now escalates the row instead of being dropped, so a later START cannot unsuppress a number that bounced or complained.

### Security

- A campaign revenue row is now keyed on the people who converted in its currency, not on the campaign's recipients: below k=5 converters its revenue and revenue per recipient are null and counted in `meta.suppressed`, while the row's recipient and converter counts stay readable (#756). `analytics.campaignSummary` follows the same rule, so a currency with fewer than five buyers no longer exposes one person's spend.
- `journeys.splitResult` applies the shared k floor per arm (#757). An arm below k=5 returns null counts and rates with `suppressed: true`, the response adds `k` and a top-level `suppressed`, and every comparison and verdict is withheld; API consumers must handle the new nullable arm fields. The journey report's split card and the MCP tool description say so.
- `POST /api/auth/oauth2/consent` now refuses a body over 16 KiB with a JSON `payload_too_large` 413 before reading it (#790). The route previously buffered an unbounded body, parsed it and replayed it into a second request before Better Auth checked the session; the 50 MB chunked case is refused while it is still arriving.
- **Breaking:** `journeys.simulate` with a `profileId` now needs `profiles:read`, because a walk reveals the person's consent, topic and suppression state; a step whose detail would show personal data (such as a phone number in a profile update) is withheld without `profiles:pii`. The dry run without a `profileId` stays at `artifacts:read`.
- Read audit entries now name the people a read reached: `profiles.find` records the profile it resolved, and `segments.preview` and an unfiltered `messages.list` record one entry per sampled or listed person (at most 50), so `audit.list` can answer "who accessed which person".
- The shared personal-data detector now also finds national-format phone numbers (`555 123 4567`, `(555) 123-4567`, `020 7946 0958`) and postal addresses, so allowlisted consent-proof free text is withheld from roles without `profiles:pii`. ISO dates, plain counts and ids with letters are not treated as phones.
- Hosted agent memory notes now refuse an 8-digit Danish or Norwegian phone number (`12345678`) as well, and `agents.memory.list` redacts one in a note saved before this release.
- Copilot writes now go through the agent policy: the plain assistant acts as the workspace’s built-in Copilot agent, so the autonomy switch, the per-agent change and send limits, the guard and ownership holds, the mandate and the action ledger apply to it exactly as to any other agent; with agents switched off it is refused, and pausing that agent stops its writes. An agent principal that names no agent record can no longer run any write.
- The OTLP endpoint is logged as its origin only, so `OTEL_EXPORTER_OTLP_ENDPOINT` credentials in the userinfo or a token in the query string no longer reach the startup logs.
- Migration resets `SUPERUSER` and `BYPASSRLS` on an app role that already existed, and refuses an app role that can `SET ROLE` into a privileged one through a chain of memberships (a `NOINHERIT` middle role does not help): the error names the chain and the `REVOKE` that fixes it, so the migration — and therefore startup — stops instead of serving every request with row-level security off. When both attributes are already off the migration leaves them out of the `ALTER ROLE`, so a non-superuser `CREATEROLE` migration user can start a second time. `am doctor` fails with the same role, chain and fix.

### Upgrading from 0.14.10

- **Migrations:** `packages/db/migrations/0090_suppressions_update_grant.sql`.
- **Configuration:** no new environment variables.
- **Breaking changes:** `journeys.simulate` with a `profileId` needs `profiles:read`; `journeys.splitResult` returns null counts with `suppressed: true` for arms below k=5; OAuth consent bodies over 16 KiB are refused with 413; Copilot writes follow the agent policy, so with agents switched off its drafts and publishes are refused; generic webhooks whose mapping reads a header now dedupe on that header's value. Migration and startup refuse an app role that has, or can `SET ROLE` into, `SUPERUSER` or `BYPASSRLS`.
- **Manual steps:** if startup refuses the app role, run the `REVOKE` the error names (or point `APP_DB_ROLE` at an unprivileged role), then start again; `am doctor` reports the same check as `postgres.app-role`.
- **Upgrade:** download `agentic-marketing-compose-0.14.11.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.11 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.11` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.11). Run `docker compose exec app am doctor`.

<!-- issues: 750, 756, 757, 762, 763, 764, 765, 787, 790, 808, 811, 813 -->

## [0.14.10] - 2026-11-12

### Fixed

- A changelog fragment is folded once, not twice: resuming an interrupted release matches a fragment on its section and bullet text, so a `Security` entry that repeats an `Added` bullet keeps its section and its issue number, and a folded fragment that names an issue the section's marker lacks adds it before the fragment is deleted.
- The release version is checked against the full SemVer 2.0.0 grammar in one script that the workflow's first job calls, so `0.14.3-..`, `01.2.3` and `1.2` fail the release before anything is built (`prepare.mjs` and the changelog fold use the same check).
- An SMS body that splits its opt-out instruction with carrier boilerplate ("Reply STOP. Msg & data rates may apply. To opt out") no longer gets a second footer; a body with no instruction still gets one, and the match stays linear.
- Consent proof shown to a role without `profiles:pii` no longer includes a free-text import label, which can name a person: it shows the fixed label "Imported" and marks the proof as withheld. A role with `profiles:pii` still sees the original label.
- Returning to a segment tab re-reads each watched segment once, not once for focus and again for visibility. A bundled purposes rollback now shows the same “moves the live … back” warning as templates, segments and blocks.
- An e2e settle timeout now names the condition still pending, the skeleton selectors or the on-screen images that never finished, so a flaky route explains itself.
- The visible unsubscribe-link check now applies simple `<style>` rules that set `opacity`, `font-size` or `color`, using the same tag/class/id cascade and limits as `display`, `visibility` and `background`, so a stylesheet rule can no longer hide the link from the save and publish gates.
- A campaign summary request whose `to` falls before a campaign that has sent later returns its readiness instead of rejecting the default window as reversed; an explicit `from` after `to` is still refused.
- Archive and web-version extraction finds `<style>` and `<body>` tags in the original document with an ASCII-only case fold, so a character such as `İ` no longer shifts the body and stylesheet slices.

### Security

- The archive and web-version sanitiser now bounds a whole render by one clock, checks it while scanning and while walking a deep open-element stack, and decodes the whitespace entities that could hide a `meta refresh` from the scanner. Input past any bound still fails closed to escaped text.

### Upgrading from 0.14.9

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** consent proof read by a role without `profiles:pii` shows "Imported" instead of a free-text import label and is marked withheld. E-mails whose unsubscribe link a `<style>` rule hides with `opacity`, `font-size` or `color` are now refused at save and publish.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.10.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.10 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.10` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.10). Run `docker compose exec app am doctor`.

<!-- issues: 671, 672, 673, 732, 735, 746, 747, 748 -->

## [0.14.9] - 2026-11-12

### Changed

- The rest of the grouped dependency update from #720 lands: OpenTelemetry `sdk-node` and the OTLP trace exporter move from 0.223 to 0.301, the Anthropic SDK from 1.0 to 1.8, Vite from 8.3.5 to 8.3.8, Biome from 2.5 to 2.6, Playwright from 1.64 to 1.65, and Vitest from 5.0 to 5.1, together with the current minors of the AI SDK, Hono, the MCP SDK, Tailwind, React Flow, GrapesJS, lucide, zustand and the e-mail, ClickHouse and parser libraries.
- OpenTelemetry tracing now also reports `os.*` and `service.instance.id` resource attributes, and requires Node.js 22.15 or newer when it is enabled. Nothing needs to change in the tracing configuration.
- Biome 2.6's new `noComponentHookFactories` rule flagged seven test-only helper components that were declared inside a test; they now sit at module scope. No rule was disabled, and the mechanical format/fix pass had nothing left to change.
- Updated the HTML parser to htmlparser2 12. The e-mail unsubscribe-link check no longer counts a link inside inline SVG or MathML as visible: many e-mail clients strip inline SVG, and the new parser exposed links that Chromium never draws there. A normal footer link beside an SVG icon still passes.

### Security

- The auth stack moves to Better Auth 1.7.22 together: `better-auth`, `@better-auth/{core,oauth-provider,sso,mcp,cimd}`, `@better-auth/utils` 0.5.1, `@better-fetch/fetch` 1.3.3, `better-call` 1.4.5 and `jose` 6.2.16. The `pnpm` overrides that held three of those packages at 1.7.7 are gone; the new Dependabot group moves the whole stack in one PR.
- A password reset that fails to save or to revoke the person's sessions no longer keeps the new password or burns the link, so the same link still works.
- OAuth consent is per brand: granting an MCP client access in one brand is no longer reused, or overwritten, by a grant in another.
- Sign-in is stricter with identity providers: OIDC SSO providers whose issuer does not match discovery are refused at registration, and SAML responses are checked against the clock skew and replay protection (including assertion IDs written as XML character references). SAML certificates and callback URLs can now be rotated for accounts that are already linked.
- Revoking the current session or deleting the account now expires the session cookie immediately, and a `"false"` `email_verified` claim no longer counts as verified.

### Upgrading from 0.14.8

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** an e-mail whose only unsubscribe link sits inside inline SVG or MathML is now refused at save and publish; move the link into the normal HTML footer. With OpenTelemetry tracing enabled, the server needs Node.js 22.15 or newer (the published images already ship it).
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.9.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.9 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.9` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.9). Run `docker compose exec app am doctor`.

<!-- issues: 727 -->

## [0.14.8] - 2026-11-12

### Fixed

- A single failed alert measurement (for example a ClickHouse timeout) is retried on the next scheduler tick instead of silencing the rule for up to an hour; a rule that keeps failing backs off after three attempts and logs the failure streak once.
- Deleting an alert rule also removes its firing history, and the history list never shows episodes whose rule no longer exists (nor a raw rule id with the wrong value unit).
- Editing an alert rule keeps each e-mail channel as it was saved; renaming a rule no longer flattens several e-mail channels into one and rewrites the notification targets.
- An hourly hosted agent now runs at minute 0 of every hour in the workspace's time zone instead of only at midnight, and its next run is computed by jumping to the boundary rather than scanning minutes, so creating or running a weekly agent no longer stalls the server for about a second.
- Two segment refreshes in the same minute now both publish their Segment Entered and Segment Exited events, so a journey triggered by a quick re-entry is no longer lost to the event bus's duplicate window.
- An independent model check that cannot record its usage now keeps its AI budget reservation through the billing month, so the tokens the provider billed are no longer counted nowhere.

### Upgrading from 0.14.7

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** behaviour changes only; no command, artifact field, URL or setting changes.
  - **Hourly hosted agents** now run every hour instead of once a day at midnight, so they use more runs and AI budget. Review hourly agents' budgets after upgrading.
  - **Next-run times** of daily and weekly hosted agents can move by an hour around DST transitions, to the time the schedule actually names.
  - **An independent model check** whose usage cannot be recorded now fails, and the publish it guards waits for review, instead of passing with uncounted tokens.
  - **A persistently failing alert rule** is retried every tick for three attempts, then backs off to its normal interval.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.8.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.8 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.8` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.8). Run `docker compose exec app am doctor`.

<!-- issues: 601, 620, 621, 622, 628, 633, 642 -->

## [0.14.7] - 2026-11-12

### Fixed

- The approval drawer now resolves the consent topic the way the composer and send time do: a broadcast's topic override wins over the template's own topic, so the evidence describes the actual send.
- Bundled dependencies always show the live version beside the bundled one, and an approval that would move a live version backwards says so on the row and in the summary.
- A broadcast with a send window no longer claims that arrival time varies by reader in the When row; it describes the reader's local window.
- An unresolved saved purpose is named "Unavailable purpose" in the approval consequences and the imports list, with the technical key only behind its copy control.
- The broadcast composer now follows a template that was republished elsewhere: its checklist, consent evidence and preview re-read the new live version, and Refresh checks re-reads the template even when the publication pointer has not moved.
- The composer preview distinguishes a segment that is still loading (“Segment…”) from one that could not be read (“Unavailable reference”), instead of calling a fresh selection dead while its name resolves.
- A segment estimate now records the published versions of the referenced segments it was counted from and turns into a previous estimate when one of them is republished, including when the change happened in another tab.
- An allowed site on a signup form is now compared case-insensitively, so typing `https://MySite.com` no longer publishes a form that refuses every real submission; the origin is saved with the scheme and host lowercased, and the editor shows the stored value when the field loses focus.
- Switching a form's hosted-page override off no longer deletes its colours and wording when the draft is saved; the values stay in the form and come back when the override is switched on, while the hosted pages use the workspace brand until then.

### Upgrading from 0.14.6

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** additive interface changes only; nothing is removed.
  - **`segments.preview`** returns `segments: [{ id, version }]`, the referenced segment versions the count used.
  - **Forms:** content gains an optional `hostedPagesEnabled` (absent means enabled, as before), and `allowedOrigins` are stored in lowercase on the next save. Agents that compare stored origins byte for byte should compare case-insensitively.
  - **Approvals:** an approval that moves a live version backwards now shows a warning. Approving is still allowed.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.7.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.7 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.7` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.7). Run `docker compose exec app am doctor`.

<!-- issues: 581, 582, 583, 584, 585, 597, 598, 599, 600 -->

## [0.14.6] - 2026-11-12

### Fixed

- Webhooks → Recent deliveries and each endpoint's "Last delivery" now read only webhook deliveries. Busy connector-action or ad-conversion traffic can no longer fill the delivery cap and make a working endpoint show "Never".
- The read-only demo now also disables controls whose handler names are camelCase (`onDelete`, `doDelete`, `mutateRoleNow`, `applyTopic`, `changeTopic`) instead of letting them fail with the demo's refusal message.
- Signing out now clears the local session only after the server confirms it; a refused or unreachable sign-out keeps you signed in and says so, instead of claiming you signed out while the session is still live.
- Choosing a different starter recipe now shows that starter's form, even when an earlier read finishes last; a slow previous selection can no longer overwrite the parameters or preview.
- The People list drops pages cached before a person was erased, so a removed person is no longer shown as a current row.
- The copilot's token count starts at zero for a new chat and when an earlier conversation is opened, and is labelled as the current session's usage.
- Switching the thing a screen is looking at no longer shows the previous one under the new title while the new read loads: consent lookups, approval and token drawers, alert rule history, the agent Activity tab, AI usage period and kind, and Messages filters and period now withhold the previous data, show the reserved loading state, and restart paging for the new selection.
- Approval and token actions stay unavailable until the drawer's data belongs to the id in the address bar, so a decision or revoke can no longer target the previous entity.

### Upgrading from 0.14.5

- **Migrations:** `packages/db/migrations/0089_delivery_kind_index.sql`.
- **Configuration:** no new environment variables.
- **Breaking changes:** one additive command input and changed sign-out behaviour; nothing is removed.
  - **`deliveries.list`** takes an optional `kind` (`webhook`, `action` or `ad_conversion`). Existing calls without it are unchanged.
  - **Sign-out** now fails visibly when the server refuses it or cannot be reached: the person stays signed in and sees an error instead of a signed-out screen over a still-valid session.
  - **Read-only demo:** eight journey-builder controls that change data are now disabled in the demo.
  - **Migration 0089** builds `deliveries_kind_recent` with `CREATE INDEX CONCURRENTLY`. On a large delivery log it takes a while but does not block delivery writes.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.6.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.6 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.6` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.6). Run `docker compose exec app am doctor`.

<!-- issues: 580, 595, 596, 611, 612, 613, 614, 615, 616, 617, 618, 619 -->

## [0.14.5] - 2026-11-12

### Fixed

- The campaign evaluation's per-member rows now apply the same k-anonymity rule as the measure layer: a member that reached fewer than k=5 people has its counts and rates suppressed, `meta.suppressed` counts the hidden rows, and the page no longer claims k-protection when nothing was suppressed.
- A journey holdout now follows the same k rule as its member row: when the row is suppressed, or either arm has fewer than k=5 people, its counts, rates and lift are null, `suppressed` is true, and `meta.suppressed` counts it; the page shows "Suppressed" instead of numbers.
- The k rule now applies to every holdout read, not only the campaign summary's journey rows: `journeys.holdoutResult` and `campaigns.holdoutResult` hide both arms, the lift and campaign revenue when either arm has fewer than k=5 people, return `suppressed: true` with `k`, and say why. The journey report and the campaign cards show "Suppressed" and the k line, never a zero count.
- Per-member counts ignore message events without a profile id, so an unprofiled send no longer adds a phantom person to the row or deflates its click and unsubscribe rates.
- `analytics.campaignSummary` clamps its documented default window to the 400-day cap (`max(campaign start, to − 400 days)`), notes when it shortened the window, returns readiness instead of rejecting a default window whose campaign starts after now, and rejects a reversed explicit window with a message that names the fix.
- The summary keeps `campaign.recipients` as people reached on any channel, but labels the e-mail figures as e-mail and computes e-mail rates and funnel shares on the e-mail base (`email.sent`/`email.delivered`), so a campaign that also sends SMS or push no longer shows recipients above e-mails delivered or divides e-mail counts by all-channel recipients.
- Ad performance now counts conversions that carry only a user id (server-side orders, CRM and offline imports) as unattributed instead of dropping them, so their revenue appears in the report.
- Experiment results describe the published version of a live experience, so editing a draft no longer changes its goal, analysis method, threshold or control; the response names the version it describes.
- The journey funnel API computes its drop-off chain in the published journey's node order and leaves out steps from older versions, so republishing a journey no longer mixes topologies. When no published topology exists it reports per-step reach without a claim of a chain.
- The "latest event in period" line now applies the same event types and conversion names as the result, and is unavailable when the filters can match nothing.
- The e-mail measures count only `channel = 'email'`. Workspaces that also send SMS or push will see their e-mail numbers drop where those channels wrote sent, delivered or other shared message events; the measures are named and described as e-mail, so the old figures included other channels.
- Campaign analytics gives every campaign its own attribution window, even when an earlier campaign has several sending members, and keeps campaigns with recipients but no conversions in a revenue query with revenue 0 instead of dropping them (including the total row).
- A revenue campaign's holdout result counts the campaign's own goal event, so it measures conversions on an install with no conversion map published, and an event without a revenue rule counts as a conversion worth 0.
- The campaign headline, the per-member rows and the holdout card resolve conversion identity the same way, so a profile merge no longer makes one surface count a conversion the other misses: a recipient reached before a merge and a conversion stored under either profile still count, and a person reached as both profiles counts once. Identity resolution is scoped to the campaign's recipients, so unrelated merges elsewhere in the workspace no longer change the headline; above the bound for the largest supported campaign, the headline and the holdout report the same not-resolved note.
- Every query that ships the identity map now uses one builder that splits the three arrays into index-aligned chunks below ClickHouse's 128 KiB per-field limit and joins them with `arrayConcat`. The per-member breakdown previously sent one unchunked array, so a campaign with 4,000 recipients and a mapped identifier each failed with HTTP 500 while the headline succeeded.
- The recipient scope read is capped at the map's pair bound plus one id. Above it the campaign skips resolution instead of building a partial map, and the headline, the per-member rows and the holdout all report the same not-resolved note. The map's documented bound is now stated in pairs and bytes, not recipients, because one recipient can contribute several anonymous ids, user ids and merge ancestors.
- The headline, the per-member rows, the campaign-wide holdout and the summary's holdout rows now share one campaign identity map. Its scope is the union of the campaign's sent recipients in the window and its holdout assignments (both arms), and the bound is decided once on that union. Near the bound, one side used to drop resolution while the other kept it, so a treatment conversion stored under a merged-away profile could count in the headline but not in the holdout; now either every output resolves with the same map or every output reports the same not-resolved note.
- The journey funnel reports drop-off only for a straight-line published journey, where every node has one outgoing step and no node repeats. A branch, split, alternative wait/action exit, loop or reconvergence now returns reach per node in breadth-first order with null drop-off, so a 70/30 split that reconverges no longer reports a negative drop-off. Counts use only the published version when journey events record one.
- A linear published journey also needs non-increasing counts along the walk. Migration moves a participant to the new version without a new entry, so a later step can outnumber the entry step; when that happens the report returns `basis: "reach"` with null drop-off and a note that people joined mid-journey, instead of clamping the excess to a fabricated zero drop-off. A negative drop-off is never silently turned into zero.

### Upgrading from 0.14.4

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** several reported numbers change after upgrading; no command, URL or configuration is removed.
  - **E-mail figures drop** in workspaces that also send SMS or push: the `email.*` measures and the campaign summary's e-mail rates and member rows now count e-mail only. Dashboards, alert rules and reports built on `email.*` measures keep working but show the e-mail-only values.
  - **Campaign conversions and revenue can rise** where a campaign used the wrong attribution window, had no conversions in the revenue roll-up, or converted under a merged profile; ads totals rise by user-id-only conversions.
  - **Small groups are hidden:** member rows, journey holdouts and campaign holdouts with fewer than 5 people now return `null` with `suppressed: true` instead of counts. API and MCP consumers must handle the `null` values.
  - **Journey funnels:** journeys with branches, splits, loops or mid-journey migrations report `basis: "reach"` with null drop-off instead of a drop-off chain.
  - **Campaign summary output:** gains `headline.emailSent` and per-row `suppressed`; a reversed explicit window is now rejected.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.5.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.5 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.5` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.5). Run `docker compose exec app am doctor`.

<!-- issues: 586, 587, 588, 589, 590, 591, 629, 630, 631, 632, 640, 682 -->

## [0.14.4] - 2026-11-12

### Fixed

- Personal-data reads now write an audit record: `profiles.find`, `profiles.events`, `consent.history`, `topics.preferences`, `messages.list`, `segments.ofProfile`, `profiles.scores`, `deliveries.list`, `segments.preview` (its sample is profile ids) and `journeys.simulate` (with the person as the target when a profile is given).
- The person page shows the consent delivery actually enforces, per purpose and per channel, so a newer withdrawal on one channel is visible beside the channels it did not touch and an equal-timestamp refusal wins.
- `journeys.simulate` asks the same channel-precedence rule as the runtime, so a webhook withdrawal behind an older all-channel grant previews as “would not send” instead of “would send a webhook”.
- A strict tracking plan no longer rejects the platform's own signup, confirmation, import and e-mail carrier events, so newsletter signups keep working and imported consent is recorded.
- Tracking plans gain a `declaredProperties` setting for a declared property that is missing although required, or has the wrong type. When it is absent, plans that block unknown properties keep blocking and other plans warn; the unknown-event setting no longer affects this.
- Retention removes unconfirmed form signups that supplied a client anonymous id only when the stored event history proves an unconfirmed signup with no other activity; confirmed subscribers and people with other activity stay, and kept candidates can no longer hide an older signup.
- Delivery events from Amazon SES keep arriving after a transient failure: the SNS signing certificate is cached only after a successful fetch, a stale certificate is fetched again at most once a minute, and one timeout or 5xx no longer rejects every bounce and complaint webhook for the life of the process.
- The unsubscribe check now reads the rendered e-mail, not the template source: a footer supplied by a reusable block passes, while prose that only mentions `unsubscribe_url` is refused, with the same answer at save and at publish. The link must also be usable: a hidden link (`display:none`, `visibility:hidden`, `hidden`, a covering style or a simple `<style>` rule), one outside the body, or one with no text or image alt text is refused with the reason. Visibility is judged at the link's own text, following the CSS cascade (the last declaration wins unless an earlier one is `!important`; inline beats a simple rule), and transparent, zero-alpha or background-coloured text counts as hidden, including semi-transparent backgrounds, the `background` shorthand and table `bgcolor`. An e-mail nested more than 512 levels deep, or one that takes more than a second to check, is refused as too complex to check. Known limits (complex selectors, `@media` rules, external stylesheets, transforms and some colour forms) are listed in #707.
- UTM tagging and click tracking now cover single-quoted and unquoted `href` links that authors write inside `mj-text`; the existing double-quoted output is unchanged.
- A push message that reached some devices while others hit a transient error now retries only the failed devices with the normal back-off, instead of marking the message `sent` and losing those notifications.
- Replying START to an SMS now works: the app role may delete its workspace’s `stop` suppression, so opting back in returns 200 and never removes a bounce or complaint suppression.
- Signed inbound webhooks remember their `webhook-id` in the shared hot state: a replayed request is answered as already received and publishes nothing, while a delivery still being processed gets a retryable 503 instead of a false acknowledgement, so a crash mid-publish cannot lose the event.
- The browser SDK reads ad click-id cookies without truncating values at `=`: a value that fails the click-id pattern is dropped whole instead of a shortened, wrong id being stored.

### Security

- `fast-xml-parser` is pinned to 5.12.0 for `@better-auth/sso`, which parses SAML responses with it; 5.11.2 and earlier spend quadratic CPU on unterminated stop-node tags (Dependabot alert 21).

### Upgrading from 0.14.3

- **Migrations:** `packages/db/migrations/0088_suppressions_delete_grant.sql`.
- **Configuration:** no new environment variables.
- **Breaking changes:** stricter unsubscribe-link checks, a new tracking-plan setting, more audit records and changed webhook replay answers.
  - **Marketing e-mail templates are checked more strictly.** A template whose unsubscribe link is hidden, outside the body, empty, or only mentioned in prose is now refused at save and at publish, and so is one too complex to check. Templates that passed before can now be refused; open them and fix the footer link (the message names the reason). Transactional e-mail is not affected.
  - **Tracking plans:** the new `declaredProperties` setting decides what happens to a declared property that is missing or has the wrong type. Plans without it keep blocking when they block unknown properties and otherwise warn; the unknown-event setting no longer affects this.
  - **More audit records:** the personal-data reads listed under Fixed now each write an audit record, so the audit log grows faster on workspaces that read profiles often.
  - **Inbound webhook replays:** a repeated `webhook-id` is acknowledged without publishing, and a delivery still in progress gets a retryable 503. Senders that retry on 503 need no change.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.4.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.4 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.4` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.4). Run `docker compose exec app am doctor`.

<!-- issues: 592, 593, 623, 624, 625, 626, 627, 634, 637, 638, 639, 643, 644, 664 -->

## [0.14.3] - 2026-11-10

### Changed

- Release tooling is crash-safe and honest: changelog folding is atomic and retry-safe, `close-issues` fetches and verifies the predecessor tag before widening a range, generated migration lists include only added files, e2e helper and Playwright config changes suggest every suite instead of smoke alone, and a tag push and a manual run of the same version share one release concurrency group. `scripts/open-task-pr.sh` also accepts `patch/<x.y.z>` integration branches.
- The documentation now matches 0.14.1, and setting `ROLE` to anything other than `api`, `ingest`, `worker`, `scheduler` or `all` stops the server at start-up with a configuration error instead of running a process that serves nothing. The architecture pages document the four real roles: `ingest` also answers `/v1/decide`, and the scheduler runs as a single `Recreate` replica. The status handoff, the architecture status headers, the wave 5 roadmap and the demo pointers now describe the shipped 0.14 line, and the broken source links in the Phase 27 and Wave 5 design inventories are fixed.

### Fixed

- A fresh Compose install no longer dies on a base64 database password: `.env.example` and the
  deployment docs generate `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` as hex (`openssl rand -hex 32`,
  as `am init` already did), and an unparseable `DATABASE_URL` (Compose interpolates the password
  raw, so a `/` from base64 breaks it) now stops with `Configuration is incomplete: DATABASE_URL is
  not a valid URL` and the fix, instead of a raw `TypeError` stack trace (#647).
- The shared test stack publishes its ports on `127.0.0.1` by default instead of `0.0.0.0`:
  `scripts/test-services.sh` uses the Docker bridge address (`172.17.0.1`) when it runs inside a
  container, prints the bind address it used and warns loudly if `AM_TEST_BIND_IP=0.0.0.0` is set.
  The dev OpenBao (root token) and the writable test Postgres are no longer reachable from the LAN
  unless someone asks for it (#605).
- `pnpm e2e:visual` waits for the seeded server's fixtures `/ready` instead of `/healthz`, so the
  visual run no longer starts against a server whose seed is still running (#646).
- The Helm chart no longer puts a container port and HTTP probes on the `worker` and `scheduler` roles, which never open a listener; those pods can pass readiness and `helm upgrade --wait` no longer times out or rolls back.
- A single `port` value now drives the ConfigMap's `PORT`, the container port, the Service target and the probes, and setting `config.PORT` no longer renders a duplicate ConfigMap key.
- Scheduled backups verify each backup they write, so the optional backup service's `am backup --health` becomes healthy after a good run and unhealthy after a failed verification instead of waiting for a manual `am backup --verify`.

### Upgrading from 0.14.2

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** `ROLE` is now validated: any value other than `api`, `ingest`, `worker`, `scheduler` or `all` (comma-separated roles are fine) stops the server at start-up. Previously an unknown role such as `decide` started a process that served nothing. Helm: the chart has a top-level `port` value that drives the container port, the Service target port, the probes and `PORT`; worker and scheduler pods no longer get probes or a container port.
- **Manual steps:** Helm users who set `config.PORT` should set the top-level `port` value instead, so the Service and the probes follow it. Compose installs need nothing.
- **Upgrade:** download `agentic-marketing-compose-0.14.3.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.3 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.3` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.3). Run `docker compose exec app am doctor`.

<!-- issues: 602, 603, 604, 605, 606, 607, 645, 646, 647, 648, 649, 650, 651, 652, 653, 654 -->

## [0.14.2] - 2026-11-10

### Security

- The public newsletter archive and web version now extract styles, body content and tracking pixels in linear time, memoise the rendered parts in a bounded 256-entry / 32 MB cache so a repeat request does not re-parse the issue, refuse pathologically nested e-mail HTML (parse5 itself aborts the tree past the depth cap, template content included, with a conservative pre-scan failing closed early), fail closed on tags with more than 512 attributes or any parser error, and strip SVG animation elements that could turn links into `javascript:` URLs, so one crafted issue can no longer stall or weaken the public site.
- Changing a brand domain's hostname or path prefix after seven days no longer forfeits the name: a new pending claim now expires seven days after it was made, not after the original row was created, so another workspace can no longer reclaim a host that is still being verified. The upgrade backfills existing rows as the table owner, so it applies cleanly on a populated install where row-level security is forced.
- Consent history no longer returns personal proof fields (IP address, user agent, page URL, call notes and other personal evidence) to roles without `profiles:pii`, and an otherwise allowlisted field such as `import_label` is withheld when its value contains an e-mail address or phone number; the response says `proofWithheld` and the person page shows "Hidden for your role" instead of the fields.
- Public traffic served under a registered path prefix keeps the visitor's client IP, so form submissions are rate-limited per visitor, Turnstile receives `remoteip` and consent records keep their address evidence. Such requests are also counted once in `/metrics`, under the public route group rather than the admin UI, and unmatched `/hooks` and `/scim` paths answer JSON instead of the admin page.
- Marketing SMS always ends with " Reply STOP to opt out." unless the body already ends with a real opt-out instruction — an instruction verb, a stop keyword and an opt-out purpose, optionally followed by carrier boilerplate such as "Msg & data rates may apply." — so a text that merely mentions "stop" ("Don't stop reading", "Stop & Shop", "Stop by before the deals end!") can no longer ship without one, and a real instruction no longer gets a duplicate.
- Inbound SMS replies are normalised before keyword matching and split on every run of non-letters/non-digits, so trailing punctuation, mixed case, fullwidth characters, surrounding emoji, "STOP,please", "Please STOP/UNSUBSCRIBE" and "Please stop—sending these messages" all contain the keyword. Any opt-out keyword anywhere in the reply now withdraws marketing consent and suppresses the number, however long the sentence ("I want to cancel my order", "Kan ni avsluta dessa utskick till mig tack"); a false opt-out is the accepted, recoverable failure. START and HELP still require the whole message, and STOP wins when both appear.
- Redaction of contact and payment details before a prompt or the `ai_calls` log now reaches every depth; a cycle or an oversized value is replaced with a redaction marker instead of being passed through.

### Upgrading from 0.14.1

- **Migrations:** `packages/db/migrations/0087_domain_pending_since.sql`.
- **Configuration:** no new environment variables.
- **Breaking changes:** none for configuration or URLs. Three behaviour changes to be aware of: `consent.history` omits personal proof fields for roles without `profiles:pii` and adds `proofWithheld`; an inbound SMS reply containing any opt-out keyword (STOP, UNSUBSCRIBE, CANCEL, END, QUIT and their Nordic equivalents) anywhere now opts the number out of marketing SMS, so "can you cancel my order?" does too — a false opt-out is the compliant failure; and a stored e-mail whose markup is pathologically nested, malformed or slow to parse renders as escaped text on the public archive instead of HTML.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.2.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.2 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.2` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.2). Run `docker compose exec app am doctor`.

<!-- issues: 574, 575, 577, 578, 579, 594, 608, 609, 610, 635, 636, 641 -->

## [0.14.1] - 2026-11-08

### Security

- The public newsletter archive and web version now use one linear, quote-aware scanner that removes scripts, embedded frames, `meta refresh`, event handlers and obfuscated `javascript:` links from e-mail HTML without crashing on hostile entities, while benign markup keeps its exact bytes. A spec-compliant parse5 check is the final judge where the scanner and the browser's HTML parser disagree, with a re-check after cleaning and a fail-closed escape when active content survives. Slug, tag-stripping, SVG attribute, file-name and duration parsing now run in linear time, so crafted input (including an uploaded SVG) can no longer stall the server.

### Upgrading from 0.14.0

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none. Benign archive and web-version output is byte-identical; only active or malformed markup is removed.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.1.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.1 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.1` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.1). Run `docker compose exec app am doctor`.

## [0.14.0] - 2026-11-08

### Changed

- The empty block picker points to Content → Templates, on the Blocks tab, matching the navigation.
- At 390 px the agents table keeps status and the last-24-hours summary under the agent name; Pause and the row menu stay reachable.
- The template editor's loading frame fills its reserved height instead of leaving a fixed 420/560 px shape.
- Loading screens now reserve the space their content will use, so lists, details, charts and the sign-in screen no longer jump when data arrives; skeletons stay static and appear only after 150 ms.
- Transitions use the shared 120 ms and 180 ms duration tokens, reduced motion removes them entirely, and the button progress glyph no longer spins or pulses.
- Sign-in, password reset and shared empty/error copy now state what failed and what to try next instead of showing raw server text.
- Automatic scrolling is immediate rather than smooth: the copilot's newest message and the highlighted approvals proposal no longer request `behavior: 'smooth'`, so `prefers-reduced-motion: reduce` is honoured, and a source scan fails any future smooth scroll.
- A content or asset list on a phone reserves its compact 72 px row geometry while the read is pending instead of the desktop gallery's 170 px tiles, so the list no longer jumps when the rows arrive.
- A partial provider read names the channels that failed and keeps the channels that answered usable; its Retry re-reads only the failed channels, and “Couldn’t load providers” appears only when every channel failed, never after a fully successful read.
- Home's empty blocks now name the next action: view broadcasts, journeys, agents, alerts or the approvals queue, and say when the block only describes the loaded sample.
- Home, approvals and agent screens use reserved loading slots, so lists, KPI tiles, the review drawer and the activity ledger keep their layout while data arrives.
- The agent comparison controls move into the card on a phone, keeping the page at 390 px, and the agent Pause and approval footer remain reachable and unobstructed.
- Agent copy now says Failure for a run's error column, avoids a healthy verdict when no run has finished, and points empty credential and comparison states to Integrations.
- Journey purpose selection now shows the purpose name only; an unresolved saved purpose is named and its technical value stays in the copy affordance.
- On a phone, the journey builder shows every step as readable text beside the canvas, and broadcast actions stay inside the 390 px viewport.
- Marketing loading states use the reserved skeletons, and automatic canvas fits and report charts no longer animate.
- Audience and consent screens name purposes in ordinary labels: the consent summary, the record drawer, the append-only ledger, imports and segment conditions no longer expose technical purpose keys, and a recorded choice names its purpose in the toast.
- At phone width the consent purpose table stacks its lawful basis, channels, people counts and double opt-in, so counts are readable without panning the table.
- People, person, consent, imports, segments, forms, purposes and editorial topics reserve their loading geometry with the shared skeletons instead of generic placeholder lines.
- Template editors name purposes and topics without their technical keys, and a saved purpose that no longer exists reads “Unavailable purpose” with the key available only in the copy control.
- The visual editor, the asset galleries, the e-mail preview, the hosted-page preview and the brand detail reserve their real geometry while they load, with object-specific status labels.
- The visual editor's inspector uses app copy (“Select an element to edit its styles”) instead of naming its internal tool.
- Empty content lists name the create or upload action; the asset picker's empty state names uploading.
- Recipient-facing hosted pages, the archive and their headers are unchanged and pinned by an output test.
- API tokens show their status beside the name at 390 px instead of off the right edge; brand, owner and last use stay in the token detail.
- The strict-input hint now states the seven-day observation and what it does not guarantee, with `STRICT_INPUTS=true` kept in technical setup.
- Insights and settings loading states use the reserved skeletons, report KPI tiles and charts keep their final geometry, and metric tables keep their period, denominator and freshness.

### Fixed

- A demo `Select` no longer drops a caller's `aria-description` when the control is unrestricted, and a restricted select ignores a change event instead of running its command.
- The `nodemailer` copy used by the development SMTP server is now 10.1.4, closing three Dependabot advisories; the runtime copy already used a patched version.

### Upgrading from 0.13.0

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none. Phase 28 changes presentation only: commands, artifacts, URLs, configuration and recipient output are unchanged.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.14.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.14.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.14.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.14.0). Run `docker compose exec app am doctor`.

<!-- issues: 552, 555, 556, 557, 558, 559, 560 -->

## [0.13.0] - 2026-11-08

### Changed

- The browser suite runs the way CI does from any checkout: `scripts/e2e-docker.sh <smoke|functional|axe|visual|update|shots>` builds the UI, starts the seeded server on a fresh database, waits for `/ready`, verifies the seed by database name, runs Playwright in the pinned image and stops the server by process group. `pnpm e2e:smoke` tags the critical journeys (sign-in and Home, approvals review, the broadcast composer, the template editor, people lookup and pausing an agent) for a run under three minutes. `pnpm lint` also rejects `getByLabel(...)` without `{ exact: true }` in `e2e/`, and the ambiguous label selectors now use `getByRole(..., { exact: true })` (#248).
- The test suite is deterministic: every Vitest project runs in `TZ=UTC`, fixture randomness comes from `AM_TEST_SEED` through a shared seeded RNG, journey triggers and holdout fixtures get per-test names, order-independent results use an unordered assertion, and the CLI is bundled once per run instead of compiled by tsx on every call.
- The test CLI bundle now keeps every module's source-relative paths (migrations, `.env.example`, recipes, web assets and `CHANGELOG.md`), so it behaves like the real CLI, and builds into a run-unique directory shared through `AM_TEST_RUN`/`AM_TEST_CLI` so concurrent runs cannot delete each other's artifact; global teardown removes only its own. Holdout and campaign tests create enough people to guarantee both arms instead of relying on twelve randomly generated profile ids.
- The test services are now one shared, labelled `am-test` stack per machine (`docker-compose.test.yml`, `scripts/test-services.sh`), with preflight and label-scoped cleanup scripts (`scripts/preflight.sh`, `scripts/docker-clean.sh`) and a run-scoped `AM_TEST_RUN` namespace so concurrent checkouts no longer collide on database, ClickHouse, NATS or Valkey names. Product behaviour is unchanged; CI keeps its own service containers.
- Test-run housekeeping now has one authoritative name: `scopedDbName()` in `packages/db/test/run.ts` (printed by `packages/db/test/print-db.ts`) bounds and hashes long run ids and refuses identifiers over 63 bytes; `pnpm test:clean` removes only the current run unless `--all-stale` proves another run is idle and old; package NATS streams are deleted by run prefix; `e2e/ports.ts` moves every e2e consumer with `TEST_PORT_OFFSET`; preflight reports UNKNOWN port availability as a failure unless `AM_TEST_ALLOW_UNVERIFIED_PORTS=1`; and the stack scripts fail fast without bash 4 and GNU coreutils on macOS. Product behaviour is unchanged.
- Releases are one pass instead of a checklist: `scripts/release/prepare.mjs` bumps every version surface (including the README default and release line), folds `changelog.d/` fragments and `## [Unreleased]` into the version section, generates the `### Upgrading from …` block from migrations and `.env.example`, records new variables in `ENV_SINCE`, and runs `check-versions.mjs`. `scripts/release/verify.sh` checks a published release's checksums, attestations and both image platforms, and `scripts/release/close-issues.mjs` closes the issues the release still owes. Contributors and delegates now add a fragment under `changelog.d/` instead of editing `CHANGELOG.md`, so parallel merges no longer conflict on the changelog.
- `pnpm test:affected` runs only the Vitest tests a change can reach (`scripts/test-affected.mjs`, with `--print` to show the selection and why). Migrations, test configuration, dependencies, workflows and any unclassified path still select the full suite; CI keeps running everything.
- Phases are built on a phase branch with one draft pull request per delegate task (`docs/process/delegates.md`, `scripts/open-task-pr.sh`), so CI validates each task on its own; a pull request template asks for the closing issue, risk, evidence and upgrade notes.
- The artifact list and detail pages accept optional content slots for the new screen layouts while every existing page keeps its current header, filters, tabs and actions.
- Picker lists now share one complete index per artifact type and workspace, so repeated selectors stay fast and a saved version refreshes only the lists that show it.
- Templates has a Starters tab with the existing starter gallery, and the old recipes address opens it.
- A demo mode runs the real workspace shell on fixed sample data, with every page marked as a simulation and changes refused.
- Forms, segments, web experiences, consent and alerts now use the Phase 27 list and detail templates: one page heading, phone summary rows with every desktop field and action, a consequence summary, and a context panel (an unsaved form preview, audience meaning or experiment setup). Forms keep consent, fields, redirects, allowed sites, Turnstile and hosted-page overrides, with the override values kept while its switch is off; segment detail shares one segment index and one purposes read across all condition rows and estimates only on request; experiment results show the 95% interval as text; consent keeps the append-only ledger and record drawer, with purposes and the editorial topics queue as separate tabs; alert rules read as rows with their condition, paused/firing/not-firing state and existing actions, and a failed rule history has its own retry.
- Content now leads with thumbnails where they help: Templates is a searchable gallery with a Starters tab for the existing recipes, Blocks stays a comparison table, and Assets is a thumbnail gallery with the same upload, search and safe-delete flow. Template editing keeps the saved-version recipient preview beside the editor, Blocks keep typed parameters and “Used by”, and Brand is split into Identity, Appearance, Page wording and Newsletter archive with all seven colours, contrast warnings, every copy key and the archive fields retained.
- Settings now uses the Phase 27 templates throughout: Workspace and Approval policy are detail pages with their existing independent saves, Secrets and Users lead with their existing lists, and Preferences keeps its device-local theme. Providers are compact channel rows with an inline routing summary and a contextual Add/Edit drawer that keeps every adapter field, credential rule and one-time secret. Integrations mounts only the chosen section, so switching sections reads only that section’s data, while token deep links still open the token drawer.
- The journey builder has a grouped step palette with local search, an explicit Auto-layout action that one undo reverses, and validation shown on each affected step with its issue count and message while Check keeps the complete list, including journey-level issues.
- Recipient pages now lead with the published brand: the confirm, result, expired, unsubscribe and preference pages share one calm card with a 560–640 px reading measure, mobile gutters, one clear heading, a single primary action and a quiet way back. The public archive index, issue, signed web version, RSS and sitemap keep their paths, headers and machine-facing output while gaining the same brand-led reading layout and labelled navigation.
- The shipped starter recipes keep their subjects, paragraphs, parameters and Liquid links, with renewed 600 px e-mail markup: a brand line, a 24 px heading, 16/26 reading text and a 13/20 footer. Nothing tracks a recipient before consent, and no hosted page gains a script or a new public route.
- `/demo` now runs the real workspace shell on fixed sample data, with every page marked “Simulated demo · sample data”, zero network calls and every change refused.
- The legacy demo application, its mocked command catalogue, ambient traffic and live-site walkthrough are retired; the old demo links now open the matching real destinations, and the live walkthrough leaves a short, non-executing note on Home.
- The demo serves the reads its destinations use — Home, People, Approvals, Journeys, Templates, Analytics and Settings — from a bounded seed projection, and names anything else explicitly unavailable.
- The demo is isolated from a visitor's real session: every request, including the copilot stream and cross-brand clients, goes through the demo guard with no network call; it stays under `/demo/…` (links, reloads, new tabs, and crafted `..`, percent-encoded or backslash paths), while external URLs pass through unchanged and a production path never enters demo mode; and every control that changes data (buttons, switches, menu actions, icon buttons and immediate dropdowns) is visibly disabled with “Demo only · changes are unavailable.”, with a guard test that fails on a new unmarked control.
- Segment estimates belong to the rules and the request they were asked for: an edit marks an earlier count as a previous estimate, late or obsolete responses never change a newer one, and an abandoned estimate never stays loading. The shared picker index ignores out-of-date reads, refreshes pending lists after a rename or discard, and Segments reads its list once.
- The template editor's Preview control is a toggle; at 1440 the preview starts closed so the canvas keeps at least the e-mail width. Journey palette step descriptions wrap in full.

### Upgrading from 0.12.0

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none for commands, artifacts or configuration. The legacy demo application is replaced by `/demo` on the real workspace shell; its old links redirect to the matching demo pages, and the live-site walkthrough is retired.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.13.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.13.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.13.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.13.0). Run `docker compose exec app am doctor`.

<!-- issues: 521, 522, 523, 524, 525, 526, 527, 528, 529, 530 -->

## [0.12.0] - 2026-11-07

### Added

- People (#510): the list is cursor-paged with honest loaded counts (“50 shown · Page 1”, More people available / End of list) and keeps cached pages for Back; a search by exact e-mail runs only on submit. Each person shows one primary e-mail, their visible name and the profile id behind a named copy control, with consent beside every purpose instead of an aggregate. The person page adds a loaded-history timeline that interleaves events, message creations, returned message events and consent changes, names each source, keeps an independent cursor and Load more for events and messages, and captions what each source covers. Loading, empty, observed-zero, unavailable, partial-failure with local Retry, restricted, not-found, PII-hidden and last-page states are explicit.
- Campaign Evaluation (#511): the tab is now a roll-up of the campaign’s published artifacts. One `analytics.campaignSummary` read supplies the period, the distinct-person headline with its denominators, the independent funnel counts, per-member results and journey holdouts; a published campaign with a control group and a goal event adds one `campaigns.holdoutResult` read, never one read per member. Campaign and journey holdouts stay separate, revenue stays per currency, and loading, empty/not started, observed zero, null, suppressed, partial failure, restricted and not-found states each have their own copy.
- `deliverability.trend` (#508): bounce and complaint rates as workspace-local daily points, each over the delivery policy's rolling creation window with current message statuses. Zero-volume points return null rates; thresholds are today's policy and there is no pause history.
- Deliverability (#508): the page now shows all four stream statuses with their raw sample and evaluation minimum, then KPI tiles for the selected stream with numerator/denominator and today’s thresholds. Bounce and complaint trends are separate charts with the current stop and warning thresholds drawn as labelled dashed lines, followed by a nine-column table with each rolling window’s bounds. DNS checks are cards per sending domain with the fix beside every failure and a copy control only for supplied records. Loading, empty, observed zero, unavailable, below evaluation volume, partial failure with local Retry, restricted, not-found and stale-response states are explicit, and a missing DKIM selector never yields a green pass.
- `agents.mandate` (#509): the published, unarchived and unexpired mandate that applies to an agent now, with its content and the current working-hours verdict. It returns null when the agent has none, never a newer draft, and includes no credentials.
- Analytics now leads with three fixed questions — Newsletter performance, Journey conversion and Deliverability — over a grouped measure picker with plain names, descriptions and units. Each question reads one totals result and one daily series per period through the existing metric layer, shows the chart before the result table, and compares with the immediately preceding equal local-day period (#506).
- Journey Report (#507): the journey detail's Report tab now reports the current participant snapshot, selected-period entries, goal, completions and exits, and all-time step reach as separate values, with Last 7 and Last 30 complete workspace-local days. Step reach comes from the published topology's graph order; a sequential funnel appears only for one linear published version whose event steps all map, are complete, unsuppressed, monotone and have entrants — every other journey shows independent bars and says “Step reach is not a cohort funnel.” Historical step ids stay a separate unmapped list behind a copy control.
- Canvas counts for journeys (#507): `JourneyGraph` accepts optional `counts` and `countsLabel` and renders “reached all time / waiting now” per step without fetching; a node key the read did not return stays Unavailable, never zero. The builder's Counts overlay and its control-group summary share one `journeys.stats` read.
- Agents (#509): the agent page is now Overview / Activity / Mandate / Credentials with Pause always one click away in the header. Overview shows outcome and goal tiles with the period and an explicit “Latest event in period: Unavailable”, the decision breakdown by action class with count bars and a table, and journey outcomes without an artifact scan. Activity is a paging timeline with Load more, separate ownership, guardian and shadow lanes, and no closed-period claim; the guardian controls (including Clear) and shadow results are mounted only when their disclosure opens. Mandate is a matrix of action class, granted level, workspace ceiling, guardian cap and explanation from one `agents.mandate` read; missing levels default to 1 and no active mandate is never an empty level 0. Credentials list kind, since and a copy control; the hosted agent and its runs, memory notes, skills, Run now, Edit and Delete are mounted only when the hosted disclosure opens, with a paged run table. The agents list puts Pause on every active row and compares 1–20 explicit agents as small multiples from one `agents.compare` read.

### Changed

- KPI tiles on Home, the broadcast report and the agent overview name their timestamp “Latest event in period”, because it is the newest event in range, not when the data was fetched; `KpiTile` takes an optional `freshnessLabel` (default “Updated”).
- The agent page keeps its tab in `?tab=` like every other tabbed page, so Overview, Activity, Mandate and Credentials can be linked to.
- The People Imports tab loads on demand, keeping the People list inside its bundle budget.
- The People list no longer calls the loaded row count a population, no longer reads a profile per row, and no longer hides purpose keys in place of names: an unavailable purpose name is labelled “Purpose name unavailable” and its key stays behind a copy control. Consent mutations, export and erasure keep their existing controls and permissions.
- The campaign Evaluation tab shares one Last 7 / Last 30 complete-days period between the summary and the campaign-wide holdout, refreshes the same reads, and mounts neither while the tab is inactive. `CampaignEvaluation({campaignId})` and `CampaignHoldoutCard({campaignId})` keep their existing required prop; `from`, `to` and `active` are additive for the host.
- Analytics asks “What changed in your newsletter results?” with Last 7 / Last 30 complete workspace-local days by default, keeps the existing `from`/`to`/`measures`/`dimensions`/`broadcast` deep links, and keeps the AI usage tab unchanged. Changing a question visibly drops a filter the new source does not support; switching measure group replaces incompatible selections with that group’s defaults and announces it (#506).
- Analytics periods now name both date ranges and the workspace zone, rates show their numerator/denominator, and freshness reads “Latest event in period” instead of a fetch time (#506).
- The journey builder no longer polls journey stats every 30 seconds; the canvas overlay and the report refresh explicitly, and a draft or edited topology shows no count overlay because aggregate counts cannot be attributed to one saved version.
- `JourneyReport` and `JourneyStatsPage` share one implementation, so the standalone Insights page and the Report tab use the same reads, period controls and states.
- The agent page no longer scans every mandate artifact, reads a report or hosted run per agent, or opens a Pause dialog: Pause is one click with an inline Retry, and a failed Pause leaves the agent active. MandateCard’s P+2M fan-out is replaced by one `agents.mandate` read, the report and activity are read only for the selected period and only with audit access, and comparison is an explicit 1–20 agent selection rather than an implicit all-agents request.

### Fixed

- The agent Mandate tab now says whether shadow mode covers every action class or only some, and explains it on each matrix row; a People page that arrives after Refresh no longer appends a stale Next page to the new cursor stack.
- The agent Mandate tab offers Create mandate again when no mandate is active, and shows when the active mandate expires (“N days left”, a warning within three days).
- People search opens a pasted `prf_…` profile id again, as before Phase 26.
- The Analytics charts section has a heading, and the analytics result table and agent comparison table scroll in keyboard-reachable regions (axe).
- Plain wording on the agent, deliverability and People pages instead of implementation terms.
- A revenue chart is drawn only when the result carries one usable currency and the comparison period carries the same currency; mixed, missing and different-currency results keep currency-labelled table rows and replace the chart with the explained unavailable state (#506).
- Analytics no longer renders an epoch date as freshness, an absent cell as an observed zero, or old values as current after a failed refresh (#506).
- Changing the Analytics question or period, or the Deliverability stream, shows loading for the new selection instead of the previous selection's values under the new label; period totals and daily results appear only when both belong to the same selection.
- A journey draft no longer shows the live version's canvas counts, even when its steps were only saved, not published; the overlay stays hidden until the published, unmodified version is shown.


### Upgrading from 0.11.0

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none in existing commands, artifacts or URLs. Two read commands are new: `deliverability.trend` and `agents.mandate` (both `artifacts:read`). The admin UI changes:
  - Analytics opens on fixed questions with period comparison.
  - The agent page has Overview, Activity, Mandate and Credentials tabs (linkable with `?tab=`), and Pause is a single click without a reason.
  - People pages through the list with loaded counts and shows consent per purpose.
  - The journey canvas counts read “reached all time · waiting now”.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.12.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.12.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.12.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.12.0). Run `docker compose exec app am doctor`.

## [0.11.0] - 2026-11-07

### Added

- The broadcast Content tab is a single-page composer (#497): What / Who / When settings beside the live unsaved preview, the eligible-audience estimate behind a save, and four pre-send evidence rows that keep the template, provider, sending domain and purpose configuration separate from per-person consent. The composer renders the selected e-mail template at its exact version, shows an unsaved draft against the version it grew from, and never invents a recipient-zone population or a scaled audience number.
- Approval review (#498): every request opens with an “If approved” consequence summary — what publishes (and whether it replaces a live version), who would receive it, when, the direct dependencies with their required and live versions, and a bundle’s members in publish order — then the requester’s note, the exact reviewed message or artifact under a Saved vN · Under review label, and an initially open “Changes · N” diff. Evidence and consent are separate: the provider, sending-domain (including “DKIM not checked — selectors required”), template checks and purpose rows show Ready / Needs attention / Not checked / Not applicable, while eligible recipients remain an estimate from the current check. Workspace proposals describe the settings they change and explain the time-zone consequence, and every state (stale draft, four-eyes, hold, bundle, restricted role, read failure) has its own copy.
- Every artifact preview now names its source above the output — Unsaved draft (with the saved version it grew from), Saved vN or Published vN — through the shared `PreviewSource` and `PreviewLabel` contract, including hosted-page, template and e-mail previews (#499).
- The e-mail editor has one Insert palette for the six basic MJML elements and reusable blocks, an in-editor preview with Desktop, Mobile, Dark mail and Text version modes, and a local unsaved-draft renderer that never shows a saved body under an unsaved label (#499).
- Broadcast Report (#500): four people totals with period, denominator and freshness, delivery event bars, tracked opens and clicks over time, daily unsubscribes, the explicit B4 “Top links unavailable” notice, and a campaign-wide holdout with its verdict, interval and per-currency revenue. The report supports Last 7 and Last 30 complete workspace-local days, loading, error, no-data, suppressed and restricted states.

### Changed

- Broadcast content edits now stay in the composer until Save draft: the preview labels the local draft and its base version, the audience check reads only a saved version and says so while dirty, and a successful save (including an in-place draft update) or an explicit Refresh estimate is the only thing that re-runs it (#497).
- The approval drawer’s Review / Content / History tabs replace the old Preview / Changes split, so the reviewed artifact and its diff sit in one reading order; a version counts as viewed only when its rendered Review has loaded, never merely when a loading drawer opens or when a different version was opened (#498).
- The e-mail editor's GrapesJS chrome is themed with the design-system tokens in light and dark, replacing the third-party greys; Styles, Settings and Layers remain the named inspector tabs, and the duplicate Code, Import, Blocks, Full screen, Preview and device controls are gone (#499).
- The broadcast Report tab now reads the ten whole-period totals and five daily series in two `analytics.query` calls instead of the Phase 24 four-measure summary; period changes and Refresh remount every section so a result from the previous period is never shown as current. `BroadcastReport({artifactId,active})` is unchanged for its host.

### Fixed

- Removed the two deferred template-route axe findings: GrapesJS chrome contrast and scrollable regions without keyboard access. The axe allowlist is empty (#499).

### Upgrading from 0.10.1

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none in commands, artifacts or URLs. The admin UI changes: the broadcast Content tab is a single-page composer whose edits stay local until Save draft, the approval drawer's tabs are Review / Content / History instead of Preview / Changes, and the e-mail editor's GrapesJS Blocks, Code, Import, Full screen and device controls are replaced by the Insert palette and the app toolbar.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.11.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.11.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.11.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.11.0). Run `docker compose exec app am doctor`.

## [0.10.1] - 2026-11-06

### Security

- `workspace.domains.add` and `workspace.domains.update` no longer accept `status`: a domain becomes `verified` only through `workspace.domains.verify`, so an admin can no longer activate a hostname without proving that it reaches this installation (#461). This is a breaking input change; callers that sent `status` now get `invalid_input`.
- A hostname now belongs to one workspace: another workspace cannot register any prefix on a host that is already claimed or verified, and verification re-checks ownership, so a brand can no longer carve a path prefix out of another brand's verified host (#462, including the prefix-shadowing case in #479).
- The installation's admin host (`PUBLIC_URL`) and fallback links host (`PUBLIC_LINKS_URL`) are reserved and can never be registered or created as a brand domain (#480).
- Host checking is persisted once it has been switched on: removing the last verified domain no longer reverts the installation to any-Host and re-enables cross-brand public pages (#463).
- Domain verification fetches through the shared egress guard, so private, link-local and metadata targets are refused, and the caller no longer receives the internal error or HTTP status of the challenge fetch (#466).
- The domain resolver cannot repopulate its cache from a load that started before an invalidation; writes reach other server processes within the documented 5-second TTL (#464).
- The OAuth consent page renders brand names as text instead of HTML, and the sign-in, consent and invitation pages are served under a nonce-based Content-Security-Policy, so a brand name can no longer run script in a member's browser (#478).

### Fixed

- Bulk mandate renewal renews from the published version and refuses a mandate that has an unpublished draft instead of replacing and publishing it; the mandate row is locked for the hash check and draft write, so concurrent renewals become successive versions instead of both reading the same one and overwriting it (#455).
- Bulk mandate renewal locks every mandate in one deterministic id order before any write or audit entry, so overlapping bulk renewals and an ordinary edit can no longer deadlock on the workspace audit lock; per-id results and audit entries keep the caller's order (#455).
- Two migrators starting at once no longer lock each other out around a `CREATE INDEX CONCURRENTLY`: the second waits with short `pg_try_advisory_lock` attempts, sleeping in Node between them, instead of a blocking statement whose snapshot the index build waits for, and gives up with a clear message after five minutes.
- `experiences.stopRollout` takes the edge-sync advisory lock before any rollout or edge row lock, matching the background sync's order; when it still cannot get the lock in ten seconds it commits the stop with the share at 0 and the bundle hash cleared, reports `edgePushed: false` with the reason, and bumps the edge generation so a sync that read the old bundle cannot publish it after the stop.
- A notification retry no longer resends mail a delivery webhook marked `delivered`, `bounced` or `complained`: any existing message row for the idempotency key counts as done unless it is `failed` or `suppressed`, so only recipients whose send failed are retried.
- `agents.compare` marks only the mandate version that is published and unarchived now as active, so superseded or archived versions are not shown as still in force (#458).
- A held agent change re-checks ownership and conflicts when its veto window ends; if another agent now owns the artifact or has a pending change, the hold goes to a person instead of running (#469).
- `agents.compare` counts a hold once when its working-hours recheck row is also in the period (#470).
- Coordination checks and `artifacts.setOwner` lock the artifact row before deciding, so a change cannot race an ownership transfer (#471).
- `agents.renewMandates` rejects a `validUntil` in the past or more than a year away, matching its schema (#472).
- `agents.renewals` reports a recently expired mandate as a negative number of days and sorts newest expiry first, as documented (#482).
- `agents.runFailures` and the contact-pressure count have supporting indexes, and finished hosted-agent runs are removed after `RETENTION_HOSTED_AGENT_RUN_DAYS` (default 90) (#488).
- Broadcast segment and template names refresh after a change instead of keeping the old name for the rest of the session (#459).
- The shared broadcast name cache is dropped on artifact create, rename, delete and publish, with a short time limit as a backstop (#486).
- The sidebar pending badge counts decisions, so a bundle counts once, exactly as on Approvals; members are grouped by bundle id even when the bundle’s lead is on another page (#483).
- Broadcast detail waits for the send state before offering Publish or Submit for review, so an unknown run is never treated as no run (#484).
- Opening another broadcast resets the tab and run state instead of keeping the previous broadcast's (#485).
- Corrected the 0.9.0 accessibility note: the axe known-issues list started with two deferred GrapesJS entries, not empty (#491).
- The scheduled-backup override example honours `CLICKHOUSE_DATABASE` from `.env` instead of pinning `am` (#492).
- The image healthcheck has a start period, so a slow migration is not reported as an unhealthy container (#493).
- Domain claims, expired-claim reclamation and verification are serialised per normalised hostname, so two workspaces can no longer both claim one host at different prefixes, and verification refuses with "the domain changed during verification" if the row's host, prefix or token changed during the challenge fetch (#462).
- A pending domain claim expires after seven days and can then be reclaimed by another workspace, instead of blocking the hostname forever; a new claim removes every expired claim on that host, at any prefix, so an abandoned row cannot be verified after the host has moved (#467).
- Verification and the installation-wide routing policy it switches on are written in one transaction, so a crash can no longer leave a verified domain without Host checking (or the policy without the verification) (#463).
- A row already verified on the reserved admin or fallback links host is quarantined by the resolver, so it cannot take the installation's host over, and `am doctor` reports it with the command that removes it (#480).
- A domain hostname with an explicit non-default port is refused with an input error instead of being silently stored without the port; default ports are still accepted (#481).
- `workspace.get` and `workspace.memberships` report a `primaryDomain` only when the primary domain is verified, matching the links and public pages (#465).
- Twilio STOP/inbound and delivery-status callbacks validate their signature against the URL that was actually called, so fallback, secondary and prefixed brand hosts keep working after the primary domain changes (#457).
- The Helm chart renders every host in `ingress.extraHosts`, so Kubernetes installs can route each brand's verified domain, and the Kubernetes guide documents the per-brand Ingress and TLS requirement (#490).
- An agent can no longer restart a ramp a person stopped by republishing the experience, its metadata, an un-ramped version or a change that runs automatically after its veto window: the original requester travels with the publish; only a person’s resume or republish starts it again, and the stop records who made it (#454).
- A guardrail pause e-mail is claimed in one commit, sent, then marked in a second: a later failure leaves it owed and retries with a backoff and a bounded attempt count instead of rolling the pause back or marking a failed send as delivered. Delivery is at least once, with deduplication by the stable key and a bounded number of attempts: a crash after the provider accepted the message can repeat it, while a retry skips a recipient whose message row already exists (#473).
- Each ramp is swept in its own transaction: one ramp’s failing guardrail read records an error on that ramp and freezes only it, instead of aborting every due ramp in the workspace (#474).
- A mandate’s `learning.experienceRamp` requires at least two steps, a first step below 100% and a guardrail, so a one-step `[100]` rollout no longer satisfies it (#475).
- `experience.rollout_paused` is delivered from a durable pause row, so a `stopRollout` before the event sweep no longer drops the pause agents were waiting for (#476).
- `experiences.stopRollout` waits up to ten seconds for a running edge sync instead of skipping the push, pushes the stopped bundle to Cloudflare KV from the same transaction, and reports `edgePushed` with a reason when it could not; the remaining delay is the worker’s isolate cache and KV propagation, stated truthfully in the command and the docs instead of “at once” (#477).
- Delivery caps count a completed contact from when the provider actually sent it (`messages.sent_at`) instead of from enqueue time, so a backlog that waited for quiet hours, a pause or a retry consumes the window from its real send time (#453).
- Two messages queued at the same instant can no longer both pass a `max: 1` frequency or cross-agent contact cap: in-flight reservations are ordered by enqueue time and message id (#452).
- An in-flight reservation that was queued outside the cap window still consumes it until it completes, and the cap decision is serialized per person with a transaction-scoped lock, so two messages queued eight days ago can no longer both pass a seven-day `max: 1` cap (#452).
- An identity merge moves the merged person's message history to the surviving profile in the same transaction, so routine identity resolution no longer resets their frequency and cross-agent contact caps (#460).
- `workspace.create` enforces a per-person brand quota (`WORKSPACE_QUOTA`, default 10) instead of letting one owner create unbounded brands and pending domain claims; the refusal names the limit, and the count and create are serialised per owner so parallel creates at the boundary cannot overshoot it (#487).
- An OAuth brand choice is bound to the authorization request that asked for it instead of the browser session, so consenting in one tab can no longer issue a grant for the brand chosen in another tab, and refresh tokens keep the brand (#456).

### Upgrading from 0.10.0

- **Migrations:** 0081–0086 add the Host-checking state, `messages.sent_at`, the durable rollout pause log and the message-cap and agent indexes. 0082 only adds the column (metadata-only, no table rewrite). 0084 and 0086 are marked `-- am:no-transaction` and build their indexes with `CREATE INDEX CONCURRENTLY`, so sends and other writes continue while they run. A normal migration is still one transaction.
- **Background backfill:** the migration does not rewrite `messages`. After the scheduler starts, it fills `sent_at` for already-completed messages in batches of 10,000 in short transactions. It stops when no row is left or a batch fails; there is no continuous retry, so a failed pass runs again on the next start (or restart). Until a row is filled, delivery caps count it from `updated_at` exactly as 0.10.0 did, so caps stay correct throughout. `am doctor` reports how many completed messages are left (`migrations.sent-at-backfill`); no manual step is needed.
- **Interrupted index build:** if a `CREATE INDEX CONCURRENTLY` is interrupted, its index is left invalid. The next `am migrate` (or server start) drops that index and builds it again; `am doctor` reports one that is still present (`migrations.invalid-indexes`).
- **Rollout pauses:** a ramp paused before 0.10.1 was already e-mailed by the old in-transaction path. It is recorded as notified and is **not re-notified** after the upgrade, so an upgrade does not send a burst of old pause e-mails. Only pauses created after 0.10.1 are delivered from the durable outbox.
- **Migrations, reserved hosts:** a domain claim on the installation's own admin host (`PUBLIC_URL`) or fallback links host (`PUBLIC_LINKS_URL`) is now ignored by the resolver, including one verified under 0.10.0; `am doctor` lists any such row with its id; remove it with `workspace.domains.remove` and give that brand its own hostname.
- **Configuration:** two new optional variables: `WORKSPACE_QUOTA` (default 10, how many brands one person may own) and `RETENTION_HOSTED_AGENT_RUN_DAYS` (default 90, how long finished hosted-agent runs are kept). Both are passed through by the Compose file and the Helm chart.
- **Breaking changes:** `workspace.domains.add` and `workspace.domains.update` no longer accept `status`; a domain becomes verified only through `workspace.domains.verify`. A hostname with a non-default port is refused. A hostname belongs to one brand; unverified claims expire after seven days and can then be taken by another brand. Once any domain has been verified, Host checking stays on even if the last verified domain is removed. A mandate's `learning.experienceRamp` now requires at least two steps, a first step below 100% and a guardrail. `agents.compare` covers at most 20 agents (the most recently active when none are named) and reports `truncated`. `experiences.stopRollout` reports `edgePushed` and `edgePushReason`; a successful push still needs Cloudflare's propagation time. Rollout pause e-mails are delivered at least once, de-duplicated by key, with bounded retries.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.10.1.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.10.1 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.10.1` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.10.1). Run `docker compose exec app am doctor`.

## [0.10.0] - 2026-11-06

### Added

- Home at `/` (#447): a role-ordered page of what needs attention (pending reviews and holds from one approvals page, firing alerts, guardian caps and recent failed hosted runs), what is running (scheduled and sending broadcasts, live journeys and active agents) and how e-mail is going (sent, delivered, clicked and click rate for the last seven complete local days, with a same-length comparison). Every block loads and fails independently from bounded reads; restricted roles get no read or block they cannot use. A derived setup checklist for a new brand reads the published brand, marketing provider, verified primary link domain and audience from current state, and can be hidden per person and device. The sending-DNS advisory is separate and never blocks completion.
- The Phase 24 navigation and shell (#446): a New menu with the exact creation order and gates, the command palette's Recents (per person and workspace, using successful detail reads only), Create actions and Go-to pages, the `?create=<type>` seam that opens each existing create dialog once, and the `/create` gallery with Blank and Starters tabs.
- `broadcasts.list` returns the operational rows a broadcast list needs in one read: each broadcast's run (status, counts, times and error), the segment and template it is pinned to, the staged send's stage and stop reason, and its messages by current status. Filter by run status before paging, and follow `nextCursor` for the filtered `total`. `broadcasts.status` keeps its output and shares the same run, stage and delivery projection.
- `agents.runFailures` lists recent failed hosted runs across every agent since a given time, newest first, with each agent's name, summary and error. It is a bounded failure queue, not an incident lifecycle.
- `approvals.list` adds `total` for the same status and artifact filter (including held rows) and a `nextCursor`, so the approvals destination can page the whole queue. Bundle member resolution and the existing list output are unchanged.

### Changed

- Broadcasts are the first screen family on the Phase 24 v2 list/detail templates (#448). The list reads `broadcasts.list` once per page with the operational state, audience, schedule and result per row, status filters, cursor paging, and honest empty, failure and loading states; it no longer calls `broadcasts.status` once per row. The detail page shares one `broadcasts.status` read across the pill, the who/when/next summary, Sending and the context panel, chooses one primary action from the runtime state, defaults its tabs from that state (`?tab=` wins), and adds the Report summary from the existing analytics read. `ArtifactDetailPage` gains optional detail slots that default to the existing page for every other artifact family.

### Fixed

- Broadcast detail now shows the audience and template of the version that is actually sending, shows that pinned version in its metadata and labels a newer draft as a separate draft reference.
- “Open in Analytics” from Home and a broadcast Report now opens with its date range and broadcast filter; the filter appears as a removable chip and is kept in the query.
- A broadcast Report no longer shows suppressed or unavailable data as “No sends”, and its click-rate tile only says “No delivered people to divide by” for an observed zero denominator.
- Broadcast detail shows a retryable error when pending approvals cannot be read and keeps publish or submit disabled until the read succeeds.
- The Home setup checklist reads marketing e-mail and link-domain status for every role that can read them; only the settings links ask for an admin.
- Broadcast paging cannot advance with a stale cursor: Previous, Next and the status filter are disabled while a page loads, and an empty later page says “This page is empty”.

### Upgrading from 0.9.0

- **Migrations:** none.
- **Configuration:** no new environment variables.
- **Breaking changes:** none in commands or artifacts: `broadcasts.list` and `agents.runFailures` are new reads, `approvals.list` adds `total` and `nextCursor`, and `broadcasts.status` adds the run's pinned `segmentId` and `templateId`. The admin UI's URLs follow the new navigation (Work · Marketing · Audience · Content · Insights · Settings), for example `/build/broadcasts` → `/marketing/broadcasts` and `/settings/agents` → `/work/agents`; every old URL, bookmark and e-mail link redirects with its ids, query and hash. Pages that moved open as tabs in their new homes (Imports in People, Topics and Purposes in Consent, Blocks in Templates, Hosted pages in Brand, AI usage in Analytics, AI prompts in Agents); `/` is now Home instead of Approvals.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.10.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.10.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.10.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.10.0). Run `docker compose exec app am doctor`.

## [0.9.0] - 2026-11-06

### Added

- `broadcasts.status` returns `delivery`: the broadcast's messages by their current status (queued, sending, sent, delivered, failed, suppressed…), next to the event statistics in `messages`, which count every event a message ever had. The broadcast pill uses it to say Delivering, Sent, Failed or Nothing sent truthfully. Migration `0080_messages_journey_status.sql` adds the index that keeps the count cheap.
- `Identifier` for secondary ids (#437): the short form (first 8 … last 4), a copy button whose accessible name and tooltip carry the full value, polite “ID copied”/“Could not copy ID” feedback, and inline expansion to selectable full text on tap or after a failed copy. Applied to agent, credential, journey and profile ids where an artifact name is not available.
- An operational state pill (`ui/state.tsx`) with named text and a marker shape, plus the metric data-state helper (`lib/dataState.ts`) for no data, below evaluation volume, healthy, warning, paused and suppressed (#437).
- A label registry (`lib/labels.ts`) for analytics measures and dimensions, agent action classes and decisions, artifact types, event types and purposes, with a unit test that reads the analytics catalogue and fails on any missing label (#437).

- Deterministic, rich demo fixtures for UI work, Playwright and screenshots (#434). The e2e seed now generates weeks of believable activity from a seeded PRNG and a fixed clock: about 520 people with consent history, eight sent weekly issues with delivered, opened, clicked, bounced, complained and unsubscribed message events, a scheduled send and a stopped canary send, a live journey with participants on every step, a web-experience experiment, campaign conversions with UTM tags, backdated agent actions, a guardian episode, learnings, a mandate with goals, alerts that fired and resolved, and an import history entry. Counts, rates and names are stable across runs; `seed` takes a `now` option for other dates.
- A screenshot matrix for design review (#433). `e2e/screenshots.mjs` (also `pnpm shots`) captures every admin route — derived from `apps/web/src/app/nav.ts` plus the seeded detail pages (one of each artifact type, a person, an agent, a token, every approval type, the signed-out sign-in page and `/`) — at 1440, 768 and 390 px in light and dark. Captures are deterministic: the clock is fixed, motion and carets are disabled, fonts and images are loaded and skeletons gone before the shot, and relative times, dates and raw ids are masked. A manual CI run (`workflow_dispatch` → `screenshots`) produces the whole matrix as an artifact.
- Visual regression in CI (#433). `e2e/visual.spec.ts` compares a stable subset (sign-in, approvals and a broadcast approval, the journey list and builder, a broadcast, a template, people, analytics, agents and an agent, the workspace settings) at 1440 and 390 px in both themes against Linux baselines committed in `e2e/visual.spec.ts-snapshots`. Its own Playwright project keeps the functional suite fast; the `visual` CI job runs on pull requests that touch `apps/web` or `e2e` and uploads the expected/actual/diff images when a baseline fails. Baselines are only ever updated by a reviewed commit.
- Automated accessibility checks (#206). `e2e/axe.spec.ts` runs `@axe-core/playwright` with the WCAG 2.1/2.2 A and AA rules over every route in the matrix, light and dark, fails on any violation not listed in `e2e/axe-known-issues.json`, and prints the violations by rule. The list starts with the two deferred GrapesJS violations on the template route (`color-contrast` and `scrollable-region-focusable`); the wave's done criterion is that it becomes empty, and theming the editor to the design system is Phase 25.

### Changed

- Navigation is grouped by work (#446): Work, Marketing, Audience, Content and Insights with collapsible groups, Settings pinned at the bottom with its own secondary navigation, Preferences in the account menu, and the desktop rail opening named group menus. Every page has its canonical URL; the old `/build`, `/design`, `/settings/agents`, Imports, Purposes, Preferences, Journey stats and AI usage URLs redirect with their ids, other query values and hash preserved.
- Adopt the DESIGN.md v2 foundations (#436): warm stone neutrals in light and tonal surfaces in dark, the 24/32 page and 16/24 section scale, 32/40 KPIs, 13/20 UI and tables, 32/24 section rhythm, 8/12 px radii, overlays-only shadows, and the categorical/sequential/diverging data-visualisation palette in `apps/web/src/index.css` and the shared `ui` components.
- Charts now read the v2 tokens (quiet grids, direct end labels, 12/18 axis and tooltip type, system font, theme re-read without the legacy theme hook), and the new shared primitives in `apps/web/src/ui/charts.tsx` provide the KPI tile with direction-aware deltas and data states, line/area and bar charts, and the “Show data table” fallback (#436).
- Operational state replaces the publication version as the primary status (#437). List and detail headers show a state pill from the new `lib/state.ts` model (broadcast, journey, agent, experience and form families), and “Published v2” is secondary metadata. The shared artifact list, broadcast list and header, agents and agent detail adopt it; other screens follow in later phases.
- Analytics names measures and dimensions through the label registry (#437), and counts, rates and money are plotted in separate charts with their own axes instead of sharing one scale; direct end labels keep an 18 px separation and the plot reserves the right inset so they do not sit on the x-axis. Deliverability uses the metric data states: a zero-volume or below-threshold stream shows “No sends” or “Below evaluation volume” with its sample and threshold, never a green 0% health claim.

### Fixed

- Shared UI fixes from the wave 5 screenshot pass (#438): 40 px touch targets below 768 px, one navigation toggle under 1024 px, the brand logo contained in its square with an initial fallback, no epoch “newest” date on an empty Analytics query, honest People counts with cursor “Load more” and no repeated e-mail column, and page-level horizontal overflow contained to tables and canvases at 390 px.
- The brand switcher and the account menu no longer override their visible text with an `aria-label`, so the accessible name contains the visible label (WCAG 2.5.3).
- Tabs only point `aria-controls` at a panel that is rendered, and the OpenAPI link in Settings → Integrations is underlined rather than distinguished by colour alone (WCAG 1.4.1) (#206).

### Upgrading from 0.8.0

- **Migrations:** `0080_messages_journey_status.sql` adds one index on `messages (workspace_id, journey_id, status)` for the current delivery state of a broadcast. Additive; it runs on start and builds in seconds on most installs (larger message tables take longer, while writes to `messages` wait).
- **Configuration:** no new environment variables.
- **Breaking changes:** none in commands or artifacts: `broadcasts.status` gains an optional `delivery` field. The admin UI has a new look (DESIGN.md v2): warmer neutrals, larger type, 40 px controls on phones; lists show what a broadcast is doing (Scheduled, Delivering, Sent, Stopped…) instead of its version, and Deliverability says No data instead of a green ok when nothing was sent.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-0.9.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.9.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.9.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.9.0). Run `docker compose exec app am doctor`.

## [0.8.0] - 2026-11-05

### Added

- Document per-brand data semantics for multi-brand installs: the same e-mail address is a separate profile with its own consent, topics, suppression and events in each brand; unsubscribe and preference-centre links act only on their brand; erasure and export are repeated per brand; analytics, webhooks and agent credentials are workspace-scoped; and the workspace is a brand boundary, not a legal entity. `profiles.export` now names the workspace in `workspaceId`, and isolation is covered by a two-brand test (#189).
- Add a workspace domain registry (`workspace_domains`) and host resolver for multi-brand installs. A brand is a workspace, and each may register one or more public hostnames with an optional path prefix and one primary domain; the resolver picks the longest matching prefix across workspaces. `workspace.domains.list/add/update/remove` are people-only (`workspace:admin`) and audited, `workspace.get` reports a workspace's domains and effective `linksUrl`, and `am doctor` checks DNS, `/healthz` and TLS for every registered domain. `PUBLIC_LINKS_URL` remains the unchanged fallback for workspaces without a domain, and there is no SQL backfill (#186).
- API tokens and OAuth/MCP connections are bound to one brand (workspace). The consent page lets a person with several memberships choose the brand, and the grant carries it; the token UI shows the brand and offers a brand selector when creating a token; `workspace.memberships` returns only the bound brand to a credential, and its audit entries record both the token id and the workspace (#187).
- Coordinate several agents in one workspace (#426): artifacts record an owning agent (`owner_agent_id`), set when an agent creates one and changed by the people-only, audited `artifacts.setOwner`. A change beyond a draft by another active agent is capped at level 1 with a reason naming the owner; a paused or retired owner does not block. A second agent's change to an artifact with another agent's open hold or approval request is held the same way. Messages record the agent behind them (`messages.agent_id`), and the workspace `agents.contactPressure` setting caps how many agent-originated marketing messages one person gets in a window, counted across agents and enforced by the delivery policy. `agents.activity` and `agents.report` show owned artifacts, held conflicts and contact-pressure skips.
- Resolve public pages and links by brand domain. The public listener maps `Host` plus path prefix to a workspace for `/f`, `/u` (including `/u/p`), `/c`, `/a`, `/n` and `/hooks`; an unknown host is a 404 and a token, form, archive slug or asset from another workspace is refused on the wrong brand's host. Confirm, unsubscribe, preference-centre, `List-Unsubscribe`, web-version, archive, form-action, asset and provider-webhook URLs now use the workspace's verified primary domain, falling back to `PUBLIC_LINKS_URL`; path prefixes keep working and no token becomes valid on another host (#185).
- Verify brand domains before they serve. `workspace.domains.verify` fetches `<host><prefix>/.well-known/am-domain/<token>` through the egress guard and activates the domain only when it returns that token; pending domains are listed but supply no links or pages. `emailProviders.refreshWebhookUrl` re-issues a provider webhook on the brand's current host, `emailProviders.checkDomain` and `deliverability.health` report the brand link host, and `am doctor` warns when the `List-Unsubscribe` host is not DMARC-aligned with the provider's From domain (#188).
- Progressive rollout for agent changes (`experience_rollouts`, #427). An experience publish may carry `rollout` (`steps` increasing to 100, `stepHours`, an optional metric-layer `guardrail`); the scheduler widens the ramp while the guardrail holds and pauses it (with the `experience.rollout_paused` agent event and an owner e-mail) when it fails. Admission uses the existing sticky hash with a distinct salt, so a visitor admitted at 5% stays admitted at 25%, and the share travels in the edge bundle. `experiences.rolloutStatus` reads the step, share, next step time and guardrail readings; `experiences.stopRollout` sets the share to 0 at once for people and agents with `experience.live`; `experiences.resumeRollout` is people-only. A mandate's `learning.experienceRamp` (true or a minimum first step) sends an agent's un-ramped experience publish to a person.
- Compare agents and renew mandates at scale (#428): `agents.compare` reports, per mandate version, actions by class and decision, undos and vetoed or run holds, and per agent the outcomes, goals met, guardian caps and hosted AI usage and estimated cost; the agents page has a **Compare agents** section with a period picker. `agents.renewals` lists mandates that lapse soon (and expired ones still attached to active agents), and the people-only `agents.renewMandates` renews several with one note, in a savepoint per mandate with one audit entry per mandate. Conversion maps are now `audience.publish` with the `ads` channel and the `ad_measurement` purpose, audience syncs touch `channels: ["ads"]`, and `ads` is a valid mandate scope channel; `agents.report` adds the agent's audience syncs and its conversion uploads. Ad budgets and bids remain out (#212).
- Brand-aware admin shell and a New brand flow (#190). `workspace.memberships` and `workspace.get` include a brand summary (`siteName`, `logoUrl` from the published brand artifact, primary domain), the switcher shows the brand's logo, name and domain, and a person who owns at least one brand can create another with `workspace.create` (people only, audited). One transaction creates the workspace with the `am bootstrap` defaults, the owner membership, a draft brand artifact and a pending primary domain; `workspace.domains.verify` activates the domain later. Ordinary members and admins, API tokens and agents are refused.
- Product identity (#195): a geometric mark and wordmark with monochrome light/dark variants, generated favicon, app icons, maskable icons and a web manifest, head metadata for link previews, the mark on the sign-in and OAuth consent pages, and a README wordmark. The source lives in one place under `apps/web/public/brand`, generated from `packages/core/src/brand.ts` (see `docs/design/brand-assets.md`).
- The desktop sidebar collapses to a 64 px icon rail (#180). A top-bar toggle with `aria-expanded`/`aria-controls` and a tooltip controls it; the rail keeps the workspace, group icons, accessible page menus and the approvals badge. The choice is stored per person and device under `am.nav.<userId>` and read before first paint; the drawer under 1024 px is unchanged.

### Fixed

- `X-Workspace-Id` no longer affects a token or OAuth connection: a request that sends a different workspace is refused with `403` instead of silently acting in it, so a credential for one brand cannot read or write another (#187).

### Upgrading from 0.7.6

- **Migrations:** `0075_workspace_domains.sql`, `0076_agent_coordination.sql`, `0077_oauth_workspace.sql`, `0078_experience_rollouts.sql` and `0079_workspace_create.sql`. All additive; they run on start. 0079 grants the app role `INSERT` on `workspaces` so `workspace.create` runs in the caller's transaction, still under row-level security.
- **Configuration:** no new environment variables. `PUBLIC_LINKS_URL` stays the links host for every workspace without a verified brand domain. Public pages keep answering on any `Host` until the first brand domain is verified with `workspace.domains.verify`; from then on, a host that is neither a verified brand domain nor `PUBLIC_LINKS_URL`'s host gets 404 on public paths, so add every public hostname your proxy or tunnel uses before verifying one.
- **Breaking changes:** a token or OAuth connection that sends `X-Workspace-Id` naming another workspace is refused with 403 instead of acting in it. OAuth/MCP connections made before 0.8.0 keep working for people with one workspace; a person with several must reconnect and choose the brand on the consent page. Conversion maps now publish as `audience.publish` with the `ads` channel: an agent needs `ads` in its mandate's channels to publish one or an audience sync autonomously, and without a mandate the workspace's approval policy decides as before.
- **Manual steps:** none for a single-brand install. For a second brand: create it under the brand switcher (New brand, owners only), add its domain, point a tunnel hostname at the public listener and verify the domain, then refresh existing e-mail provider webhook URLs with `emailProviders.refreshWebhookUrl`.
- **Upgrade:** download `agentic-marketing-compose-0.8.0.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.8.0 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.8.0` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.8.0). Run `docker compose exec app am doctor`.

## [0.7.6] - 2026-11-05

### Fixed

- Credit a split conversion only to its explicit participant's own eligible split take. Re-entries that bypass the split or convert before reaching it no longer inflate another entry's arm. Participant identity survives profile merges; genuinely participant-less outcomes retain temporal fallback (#419).
- Keep billed hosted usage covered when accounting writes fail. Durable reservations settle atomically with usage, stable ids prevent duplicate fallback records, and both-writers-fail retains the hold. Budget refusals preserve the model-failure streak instead of disabling an agent after three refusals; actual run failures retain the three-strike rule (#420).
- Reconcile warehouse erasure-key coverage after restored identifiers are deleted, preserve original known counts, and retain unknown legacy coverage across replay and log round trips. A re-enabled destination cannot mistake pruned/missing keys for proof that no event-capable identifiers existed. Previously incorrect zero counts are recoverable while captured keys remain (#421).

### Upgrading from 0.7.5

- **Migrations:** none. Released migrations through 0074 are unchanged; the restore correction uses the existing counter and portable log metadata.
- **Configuration:** no new environment variables. Restore continues to use the documented owner/admin `DATABASE_URL`.
- **Breaking changes:** no removed command or artifact fields. Corrected split attribution can lower reports which previously credited conversions from non-participating entries. Hosted budget refusals remain visible failed run records but no longer increment the model-failure streak. Restore logs add optional known-key-count metadata while retaining older-log compatibility.
- **Manual steps:** use the updated restore CLI and warehouse workers together. After a restore, inspect `warehouse.erasureBacklog` and resolve downstream cleanup before acknowledging it. If an earlier restore already lost both the correct count and captured keys, historical identifiers cannot be reconstructed automatically and affected remote events need manual review/cleanup. Inspect provider usage and accounting errors before reconciling an orphaned billing hold; retained coverage can conservatively reduce available allowance through its billing deadline.
- **Upgrade:** download `agentic-marketing-compose-0.7.6.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.6 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.6` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.6). Run `docker compose exec app am doctor`.

## [0.7.5] - 2026-11-05

### Fixed

- Keep hosted-run MCP catalogues within granted scopes and remove invitations to call tools requiring unavailable escalation (#364).
- Read complete campaign and AI-calibration conversion windows beyond the former 100k cap, resolve historical events through current merged identities, and bound large identity query parameters (#366).
- Attribute journey split outcomes to one eligible entry and its deterministic first arm, independent of report-window boundaries; repeated outcomes count once per entry (#369).
- Page profile events, lists and exports with full-precision timestamp/id keysets through tied timestamps; exports explicitly report when `maxEvents` truncates retained events (#397).
- Resume quiet-hour holds at the earliest actual exit across DST gaps, repeated hours, overnight folds and date-line changes (#367).
- Queue every valid password-reset address through the same account-independent request path. Workers mint Better Auth verification tokens, re-check eligibility, fence claims and token revocation, bound retries and clean up payloads (#379).
- Apply public-form rate limits across replicas through shared hot state, with no local-map reset. Forms and password reset fail closed when their shared limit store is unavailable (#380 and reset-queue hardening).
- Remove the vulnerable deepmerge dependency from production email rendering by upgrading html-to-text to 10.0.1, with fixed-option rendering regressions and an explicit advisory disposition (#406).

### Upgrading from 0.7.4

- **Migrations:** `0074_password_reset_queue.sql` adds the installation-level sealed reset-request queue. It runs on startup; released migrations are unchanged. Databases upgrading released 0.7.4 end at 0073 and apply the final 0074 normally. Developers who applied an intermediate PR417 migration must recreate disposable test databases or prepare a reviewed transition for non-disposable data; never bypass checksum validation.
- **Configuration:** no new environment variables. Keep at least one worker replica running for reset mail and cleanup, keep Valkey available for public rate limits, and retain a stable `AUTH_SECRET` for pending sealed requests.
- **Breaking changes:** no removed command or artifact fields. `profiles.events` and `profiles.list` add composite cursors; legacy timestamp-only `before` requests keep their historical boundary behavior, so tie-safe traversal must use the paired id from `nextCursor`. `profiles.export` adds `eventsTruncated`. Hosted runs no longer list ungranted tools. Public forms and password-reset endpoints return a generic 503 when their shared rate limiter is unavailable; reset mail is asynchronous.
- **Manual steps:** verify worker health and transactional email configuration. Reset delivery is at least once; a crash after provider acceptance can resend a link. Worker cleanup expires unprocessed payloads after 24 hours and prunes terminal rows after seven days; neither sending nor physical cleanup runs without a worker. Rotating `AUTH_SECRET` makes pending sealed requests unreadable, and older minted verification tokens remain subject to their existing 45-minute expiry and single-use rule. Email conversion preserves the application's fixed options; raw-text `textarea`/`xmp` content follows html-to-text v10's more literal output. See `docs/deployment/operations.md` for development-snapshot handling and `docs/triage/0.7.5-bugfix-plan.md` for validation evidence.
- **Upgrade:** download `agentic-marketing-compose-0.7.5.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.5 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.5` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.5). Run `docker compose exec app am doctor`.

## [0.7.4] - 2026-11-05

### Fixed

- Track webhook alert acceptance as queued, confirmed delivery as sent, and exhausted delivery as failed (#368). Retry the same payload and outbox row after resolution or rule disablement, with one extra delivery cycle and a durable retry budget. The UI reports sent/queued/failed separately.
- Resume segment enrollment after transient chunk failures with persisted bounded backoff, preserving committed cursors, counts and published-version pins (#370).
- Exchange OAuth callback codes outside pooled transactions and fence results against newer authorizations (#375). Serialize rotating refreshes across replicas and ignore stale invalid-grant responses (#376).
- Forward all server configuration through Compose and document the environment keys (#385, #387). Remote key providers no longer require a local MASTER_KEY; empty LOG_LEVEL uses the default.
- Roll deployments after managed Secret changes and support explicit revision bumps for external Secrets (#388). Run self-contained Helm migrations before install/upgrade, with configurable resources; render accurate replica notes and reject scheduler autoscaling (#389–#391).
- Preserve edits made during an in-flight autosave and ignore stale saves across document switches (#381). Artifact lists and pickers follow full-precision keyset pages instead of stopping at 200 items (#382).
- Preserve journey-node positions and selection during statistics polls (#383). Keep invalid JSON text across refetches and restore the saved buffer on explicit Discard (#384).
- Reconcile audience destination/connection changes, identifier changes and capped additions (#400–#402). Persist immutable destination provenance and write intents before remote additions, retain ambiguous writes for cleanup, and restore complete identifier sets after member-level removals. Cleanup continues for unpublished/deleted syncs and erased/refused profiles. Shared-target ownership and merge repair preserve every recorded hash or report an explicit manual obligation.

### Upgrading from 0.7.3

- **Migrations:** 0072 adds audience provenance, write intents, bounded reconciliation state and an explicit legacy cleanup backlog. Existing audience rows have unknown historical destinations and are marked unresolved. 0073 adds enrollment retry state, OAuth refresh leases and durable alert retry budgets. Released migrations are unchanged.
- **Configuration:** Compose now forwards documented optional server settings. Helm-managed Secret values roll workloads automatically; for an existing Secret, bump `secrets.revision` after rotation or restart the deployments explicitly. Migration jobs use their own hook configuration; custom migration resources are under `migrations.resources`.
- **Breaking changes:** no command/artifact fields were removed. Existing fields are retained. Artifact pagination and audience state/recovery fields are additive. Artifact loaders cap at 20,000 items; the main list discloses partial loading. Queued webhook notifications are no longer described as sent.
- **Manual steps:** for audience cleanup, inspect `ads.audienceBacklog`, complete historical or partially shared-member removal/restoration at the provider, and acknowledge only the selected entries with human-admin `ads.acknowledgeAudienceCleanup` and a non-empty note. `ads.retryAudienceCleanup` retries recorded work. Unknown historical destinations cannot be reconstructed; this release does not claim those copies were removed. Acknowledgement does not prevent a still-eligible member from being added again by a published sync. Failed or manual cleanup remains visible.
- **Upgrade:** download `agentic-marketing-compose-0.7.4.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.4 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.4` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.4). Run `docker compose exec app am doctor` and inspect audience cleanup status.

## [0.7.3] - 2026-11-04

### Fixed

- Settle decision-call usage together with budget reservation release, and bound copilot steps by the remaining turn allowance (#355, #356). Copilot turns advertise core artifact tools plus bounded `tools.discover`, estimate only active schemas, and trim history by complete user turns so tool results keep their assistant calls.
- Allow deletion of hosted agents whose claims are stale, while refusing live claims (#362). The application role now has the database DELETE grant required by the existing human-only workspace-admin command; deletion and claim takeover serialize on the hosted row.
- Fence hosted-run completion by claim ownership so a late run cannot release its successor's claim, overwrite its failure streak, disable it or mark its events read (#363). Own-run history remains auditable.
- Preserve event triggers and event ids when event-driven hosted attempts are skipped; scheduled attempts remain labelled as scheduled (#365). Skipped attempts stay audit-only and do not consume event-run gap or daily limits.

### Upgrading from 0.7.2

- **Migrations:** `0071_hosted_agent_delete.sql` grants the application role DELETE on the existing workspace-isolated agents table. It runs on start-up; command authorization is unchanged.
- **Configuration:** no new environment variables.
- **Breaking changes:** no removed command or artifact fields. AI calls can stop earlier when their budget cannot cover another step. Copilot turns enable non-core permitted commands through `tools.discover`; commands too large for the turn budget are reported instead of offered. Live hosted claims still block deletion; claims older than 60 minutes, or missing their start time, no longer block deletion indefinitely.
- **Manual steps:** inspect provider usage/errors if an interrupted AI call leaves a conservative budget hold. Holds are reserved before provider I/O through the end of the following UTC month and removed after durable usage recording. Copilot input-token checks use an estimate; provider-specific tokenization can exceed that estimate on the final step. Audience reconciliation issues #400–#402 remain open and are deferred to 0.7.4; this release does not claim to repair prior audience destinations or remote cleanup.
- **Upgrade:** download `agentic-marketing-compose-0.7.3.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.3 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.3` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.3). Run `docker compose exec app am doctor`.

## [0.7.2] - 2026-11-04

### Fixed

- Preserve current topic preferences and static/snapshot list memberships when identities merge (#395, #396). Topic conflicts use the newest choice, with an opt-out winning an exact timestamp tie. Lists deduplicate onto the surviving profile while keeping the earliest addition and provenance. A migration repairs existing merged-away rows; history stays append-only and exports still include the merged family. Topic/preference links issued before a merge follow the survivor, and topic writes serialize with merges. Dynamic memberships are recomputed by the normal refresh.
- Audit successful `profiles.list` and `segments.members` reads, including redacted responses, through the same input-hash audit chain used by individual profile reads (#398). Decrypted output is never stored in that audit entry.
- Honor ad-targeting refusals even when an audience sync sets `removals: false` (#399). That option now applies only to ordinary segment leavers; consent eligibility is checked for all previously synced members, including people who already left the segment.
- Warehouse erasure no longer relies on an exported identifiers dataset, and incremental export change markers include identity reassignment and consent materialization changes without rewriting their original business timestamps (#373, #374).
- Edge mirroring retains cleanup work when disabled or when snapshots are turned off, and changing the KV destination resets backfill and schedules cleanup of the previous target (#403, #404). Sync workers serialize per workspace and fence configuration changes, preserving pending cleanup, late write keys and outbox work during destination moves. Token rotation preserves an omitted custom API base.

### Upgrading from 0.7.1

- **Migrations:** `0068_warehouse_change_tracking.sql`, `0069_merge_preferences_memberships.sql` and `0070_edge_cleanup.sql`. They run on start-up; merge repair transfers existing current topic/list rows along resolvable merge chains (up to 20 links), preserving history. Review the detailed validation and upgrade limits before deployment.
- **Configuration:** no new environment variables.
- **Breaking changes:** no removed or renamed command/artifact fields. `edge.status` adds cleanup progress, pending deletion counts and stale-target details. Warehouse export responses add `backlogCount`; `warehouse.erasureBacklog` lists incomplete cleanups and human-only `warehouse.acknowledgeErasures` records selected manual resolutions with a required note. Privacy corrections remove audience members after consent is refused regardless of `removals`, and disabled edge mirroring initiates remote cleanup instead of retaining serving copies.
- **Manual steps:** keep credentials for warehouse and edge destinations valid until outstanding erasure/cleanup work completes. Older warehouse erasures without captured keys require manual downstream cleanup; incomplete erasures advance the cursor and keep a metadata-only backlog and visible failure until an administrator acknowledges manual cleanup. A cross-account edge move may require manual cleanup of the old KV namespace if the current token cannot access it; `edge.status` reports the outstanding target. The first warehouse export after upgrading re-exports changed identity/consent rows. Read `docs/triage/0.7.2-bugfix-plan.md` for repair limits and final validation evidence.
- **Upgrade:** download `agentic-marketing-compose-0.7.2.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.2 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.2` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.2). Run `docker compose exec app am doctor`.

## [0.7.1] - 2026-11-04

### Fixed

- Bound JSON and webhook request bodies before buffering on password reset, copilot, push, SCIM and invitation routes (#347, #377). Empty `TRUSTED_PROXY_CIDRS` now ignores forwarded headers; configure the actual proxy ranges to preserve visitor IPs behind a reverse proxy (#378).
- Decision models inspect deeply nested state and question text for personal data, send only explicitly declared agent-visible non-personal traits, and use the existing egress guard with bounded responses (#352, #354, #357). Journey call logs keep a state hash instead of raw profile state (#358).
- Decision answers reject invalid probabilities, confidence and token usage, and prototype-inherited choice labels (#353, #361). Journey scores match the probability used to route and are stored in the same transaction that wakes the participant (#350, #351). Calibration reports dependency errors instead of returning a misleading zero-conversion report (#360), and consistently excludes expired scores before and after retention. It evaluates the latest unexpired predictions; choose a score TTL longer than the outcome window for a complete evaluation.
- Hourly retention prunes expired decision scores in bounded per-workspace batches (#359); profile erasure remains covered by the existing cascading database foreign key. Hosted agents cannot delete people’s memory notes, and concurrent memory writes respect the note and character caps (#348, #349).
- Browser SDK reset removes the stored user identity, analytics withdrawal clears queued events and prevents retries from reviving them, and a rejected page-hide beacon falls back to fetch (#392, #393, #394).
- Recheck a queued event webhook’s required purpose before each send, and let a standing ad-measurement refusal override a per-event positive signal (#405, #372). Remove known personal properties from no-plan and unlisted events as well as schema-declared PII (#371). Published non-personal property classifications take precedence over reserved-name defaults, so a product name can be retained without retaining unclassified personal names.
- Correct the README’s current release line and check it with the other version surfaces (#386). Release-bundle validation no longer falsely reports a missing upgrade field when a pipe closes early. The issue inventory, validation evidence and later 0.7.x batches are recorded in `docs/triage/0.7-bugfix-plan.md`.

### Upgrading from 0.7.0

- **Migrations:** none.
- **Configuration:** `TRUSTED_PROXY_CIDRS` still defaults to empty, but empty now trusts no forwarded headers. Set the ranges of the reverse proxies that connect directly to the application before upgrading if you depend on forwarded client IPs. Private decision-provider endpoints must be explicitly allowed by `EGRESS_ALLOWED_HOSTS`.
- **Breaking changes:** no command or artifact schema changes. Security corrections reject malformed provider responses and personal question text without a no-retention agreement; missing tracking plans no longer expose profile traits to decision providers. Calibration now fails clearly when its event store is unavailable.
- **Manual steps:** deploy the rebuilt browser SDK on your tracked sites. Review your tracking plan’s personal-property classifications and agent-visible traits. Explicitly declare non-personal event fields whose names overlap reserved personal keys (for example, `Product Viewed.name` with `pii: false`) before deploying the new collector. Existing raw decision-call inputs and previously exported personal event properties are not rewritten by this release; assess stored copies and downstream destinations under your retention/erasure procedure. For reverse proxies, configure trusted ranges as above.
- **Upgrade:** download `agentic-marketing-compose-0.7.1.tar.gz`, replace `docker-compose.yml` with its copy, check configuration with `AM_VERSION=0.7.1 docker compose run --rm --no-deps -T app am doctor --env-file - < .env`, set `AM_VERSION=0.7.1` in `.env`, then `docker compose pull && docker compose up -d` (Helm: chart 0.7.1). Run `docker compose exec app am doctor`.

## [0.7.0] - 2026-11-01

### Added

- **The copilot attached to an agent (#339).** A conversation can act as an agent under its mandate: chosen with **Act as** in a new chat by the agent's sponsor or an admin. Its tool calls run as the agent (sponsor's role ∩ the copilot's scopes), through the policy engine, in the agent's activity and limits; the model gets the agent's mandate and the active learnings. The agent gains a `copilot` credential, so pausing it stops its conversations. Migration `0067_copilot_agents.sql`.
- **Hosted agents get durable memory and published skills (#340).** A hosted agent can keep a small, inspectable list of working notes for itself (`agents.memory.add/list/update/delete`): at most 50 notes and 10,000 characters per agent, each note at most 1,000 characters, with e-mail addresses and phone numbers refused. The agent writes notes during a run and may delete its own; people read and edit any on the agent page, where the card shows the memory and the skills it references. A **skill** is a new versioned artifact type (`skl_…`, title, markdown instructions up to 8,000 characters and tags) that people approve like any artifact and agents may draft; a hosted agent references skills with `skills` on `agents.createHosted`/`agents.updateHosted`, and only the published version is used. Every run's prompt now includes the agent's notes, its published skills, the published business context and the active learnings, each in a delimited block and truncated to a total cap. Memory is a working store, not evidence: learnings (#311) remain the conclusions. Migration `0065_hosted_memory.sql` adds `hosted_agent_memory` and the `skills` list on hosted agents.
- **Event-triggered hosted runs (#338).** A hosted agent can run when agent events happen (guardrail breaches, guardian episodes, holds, approvals, experiment verdicts, alerts), not only on its schedule. Its `triggers` become an agent subscription; a run starts with the events in its prompt, at most one at a time, at least `eventMinGapMinutes` apart and at most `eventRunsPerDay` a day, on top of the run budgets. Runs record their trigger and events. Events are marked read only after a successful run (a failure is retried within the gap and cap); only agents that can run now are selected, oldest events first; paused agents run none and skip events older than a day on resume (#342, #343, #344). The deliverability guardian, lifecycle optimiser and experimentation agent templates react to their events. Migration `0063_hosted_triggers.sql`.
- **Self-service password reset (#191).** The sign-in page links to `/forgot-password`, which asks for an e-mail address and always answers "If an account exists for that address, we sent a link to reset the password" — the same answer for a known and an unknown address, whether or not mail is configured, and for single sign-on people. A password account gets a single-use link to `<PUBLIC_URL>/reset-password?token=…` that expires after 45 minutes; the page sets a new password (min 10 characters, confirmation) and signs the person out everywhere else by revoking all their sessions (`revokeSessionsOnPasswordReset`). Expired, reused and malformed links get a clear message and a way to request a new one. The mail goes through the transactional provider of the person's oldest workspace (installation-level, never a brand they do not belong to), tokens are stored hashed, the request and the reset are audited with person, IP and outcome but never the token, and both endpoints are rate limited per IP and per address in Valkey (5/IP per 15 min, 3/address per hour plus a 60-second cooldown, 10 submissions/IP per 15 min). Enforced single sign-on domains and passwordless (SSO/SCIM) accounts get no reset mail. API tokens are not revoked; manage them under Settings → Integrations. `am reset-password` stays the break-glass path. Migration `0066_password_reset.sql` adds a nullable `ip` column to the audit log so these entries say where the request came from (older entries keep their hash chain). See [docs/identity.md](docs/identity.md#password-reset-191) and [docs/deployment/operations.md](docs/deployment/operations.md#password-reset-mail).
- **`am backup --verify` checks a backup without a database (#145).** It re-reads the manifest, re-hashes every Postgres and ClickHouse file, checks the recorded sizes and ClickHouse row counts, and asks `pg_restore --list` to read the dump's table of contents. A mismatch names the file and the expected and actual SHA-256, and the command exits 1. A successful run records the time in `<BACKUP_DIR>/.verify-status.json` (`0600`). `am backup --health` now also fails when that verification is older than `BACKUP_VERIFY_MAX_AGE_DAYS` (default 30) or has never run.
- **Backups record which key they need and prove it can unseal them (#143).** The manifest gains a `key` object with the key provider's public reference (`local-<sha256 prefix>`, `openbao:<mount>/<key>` or `aws-kms:<key-id>`) and a sealed check value. `am restore` unseals that value before it touches Postgres: a wrong `MASTER_KEY` is refused with a message naming the key it needs and the `MASTER_KEY_PREVIOUS` option, before the database is replaced. After `pg_restore` it also unwraps a real data key before reporting success. `--skip-key-check` allows a deliberate override. `am doctor` adds `secrets.master-key-live`, which unwraps a stored data key in the live database. No key material is written to the manifest, a log line or an argument.
### Changed

- **mjml 4 → 5 (#205).** Templates now compile with mjml 5 on the server and mjml-browser 5 in the admin editor. Rendering is asynchronous in mjml 5, so `compileMjml` and `validateTemplate` return promises and the save-time content validation is async with them: `artifacts.create`/`artifacts.update`, bundle import and drift, and `recipes.preview`/`recipes.install` await it, as do `templates.preview`, `templates.check`, `templates.sendTest`, `blocks.preview`, the hosted archive pages and the send path. The compile options are unchanged (`validationLevel: 'soft'`, `ignoreIncludes: true`, `minify: false`), so an `mj-include` still never reads a file and templates that compiled before still compile. The generated HTML differs only cosmetically — attribute order, whitespace, and `word-spacing:normal` also on the wrapper div — and the plain-text part derived from it is unchanged.
- **Decision models (TypeSafe JEV/System One, #194, epic #192).** A third AI provider kind, `decision`, calls TypeSafe's System One API through CommandCode (`https://api.commandcode.ai/provider/v1`) or TypeSafe directly (`https://api.typesafe.ai/v1`) with a state and up to 100 typed questions (`noul`, `choice`, `score`); answers are probabilities and confidence, never text. `ai.score` meters the call through the existing reservation and `ai_calls` path (kind `score`), and can store the first answer as a named score for a person in `profile_scores` with a TTL. `profiles.scores` reads it; a segment condition `{ "score": { "key", "gte" } }` and a journey `decision` node (two edges: threshold, fallback) use it. `journeys.simulate` shows the probability, and `ai.calibration` reports a reliability table and the Brier score against a later event. Personal data is refused by default: `allowPersonalData` is false and settable only by a person under a no-retention agreement, and the state builder sends only segment ids, event counts, agent-visible non-personal traits and context. `ai.calls` keeps a state hash, never the raw state. See [docs/decision-models.md](docs/decision-models.md). Migration `0064_decision_models.sql`.

### Fixed

- **Backup permissions and key rotation are documented as implemented (#143, #145).** Local backups are plaintext files with `0700` directories and `0600` files; the documentation now says so and asks for an encrypted volume or host instead of claiming that `am backup` encrypts them. `MASTER_KEY_PREVIOUS` is documented as the way to restore a backup taken before a key rotation, for at least the backup retention window.

### Security

- **The mjml advisories are gone (#205).** mjml 5 fixes the `mj-include` directory traversal (GHSA-45h5-66jx-r2wf) and drops `html-minifier`, whose ReDoS (GHSA-pfq8-rq6v-vf5m) had no patched release. `minimatch` and `glob` are pinned with `pnpm.overrides` to the patched 11.0.1 and 14.0.2 (GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4), which `mjml-cli` — a dependency of `mjml` that the server never loads — and `js-beautify` no longer hold back. `SECURITY.md` and `pnpm.auditConfig.ignoreGhsas` now carry only the `uuid` advisory in the spikes, and `pnpm audit --prod --audit-level=moderate` passes.

### Upgrading from 0.6.1

- **Migrations:** `0063_hosted_triggers.sql`, `0064_decision_models.sql`, `0065_hosted_memory.sql`, `0066_password_reset.sql` and `0067_copilot_agents.sql`. All additive; they run on start.
- **Configuration:** optional `BACKUP_VERIFY_MAX_AGE_DAYS` (default 30): `am backup --health` now also fails when no backup was verified with `am backup --verify` within that many days, so run a verification after upgrading if a monitor calls `--health`. Password-reset mail goes through the transactional e-mail provider of the person's first workspace; without one, no link is sent and a warning is logged. `MASTER_KEY_PREVIOUS` keeps backups made before a key rotation restorable.
- **Breaking changes:** `am restore` now refuses when the configured master key cannot unseal the backup (`--skip-key-check` overrides). Decision providers refuse states with personal data unless `allowPersonalData` is set by a person.
- **Manual steps:** none. Look at one rendered e-mail in your main mail clients after the upgrade: mjml 5 renders the same content with slightly different HTML.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.6.1] - 2026-11-01

### Fixed

- **Level 4 only creates what the agent drafted itself (#325).** A never-published artifact counts as the agent's creation only when its first version was drafted by the same agent credential; a person's or another agent's draft stays inside the mandate's artifact list.
- **Level 4 is earned only from level-3 operation (#327).** The ledger records the level the policy engine decided at; a held change that ran after its veto window is level 2 and no longer counts. Ledger rows from before 0.6.1 have no level, so earning starts again from this release.
- **`agents.report` counts refusals as denies (#321)** instead of failures, **reports the journeys an agent published (#322)** (it looked for the wrong id prefix), and **counts direct-send events only inside the period (#323)**.
- **Relative feed links are resolved before they are rejected (#326).** RSS, Atom and JSON Feed items with relative links such as `/post/1` or `post/2` are resolved against the feed URL (and an Atom `xml:base` when present) and kept, instead of being dropped as non-absolute. `javascript:`, `data:` and other non-http(s) links are still refused, and absolute links are unchanged.
- **Bulk enrollment now pins the journey and segment versions (#324).** `journeys.enrollSegment` records the published journey version and segment version on the job (migration `0061_enrollment_job_versions.sql`), and every participant enters the pinned journey version. Before each chunk the scheduler checks both artifacts and stops the job as `failed` with a clear reason when the journey or segment was republished, archived or unpublished mid-flight — for example “The journey was republished (v1 → v2) during the enrollment; start a new job to enroll the rest into v2.” — instead of splitting participants across versions or continuing with an archived segment. `journeys.enrollmentJob` reports `journeyVersion`, `segmentVersion` and the stop reason. Jobs created before this change pin on their next chunk.

### Upgrading from 0.6.0

- **Migrations:** `0061_enrollment_job_versions.sql` (pinned journey and segment versions on bulk enrollment jobs) and `0062_agent_action_level.sql` (the decided level on each agent ledger entry). Both additive; they run on start.
- **Configuration:** none.
- **Breaking changes:** none. Earning level 4 starts again from this release: only ledger entries recorded at level 3 or above count, and entries from before 0.6.1 have no level. A bulk enrollment job still running from 0.6.0 pins the current versions on its next chunk.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.6.0] - 2026-11-01

### Added

- **Experimentation agent and audience curator programmes (#314, #315).** Mandate templates, MCP recipes and hosted-agent templates: one concludes web experiments with `experiences.results` (promote, remove, learn), the other checks segment sizes and overlaps and proposes sunset policies as drafts.
- **Campaign agent (#64).** A typed, versioned `campaign_brief` artifact (objective, a measurable goal on a metric-layer measure, audience and segment references, message, offer, channels, schedule, guardrails, success criteria and holdout intent, with assumptions and warnings). Agents draft briefs and only people approve them. From the approved version `campaigns.plan` returns a deterministic draft bundle — the segment to use or create, a template per channel, a broadcast per channel or a journey, and the campaign that links them with the brief's control group — without writing anything, and `campaigns.fromBrief` creates those drafts with resolved references and never publishes. The campaign records its `briefId` and `briefVersion`. Programme assets: the **Campaign agent** mandate template, an MCP recipe and the updated skill.
- **Starter recipes for common marketing loops (#150).** A versioned recipe format (`agentic-marketing/recipe@1`) ships four installable loops: a welcome journey with double opt-in (form, confirmation e-mail, welcome and follow-up e-mails, subscriber segment), a four-email lead-magnet drip over eight days, a weekly newsletter (subscriber segment, this issue's template and a broadcast) and a win-back journey for lapsed customers. `recipes.list/get/preview/install` read the gallery, validate parameters and prerequisites (an e-mail provider for marketing and a purpose with the e-mail channel), resolve `{{param.*}}` and `{{ref.*}}` placeholders, and create version 1 drafts with fresh ids. An install never publishes: the drafts go through the normal approval path (usually `artifacts.requestPublishBundle`), and agents may install drafts but their publishes follow the approval policy. The admin UI adds a Recipes gallery under Build, and [docs/recipes.md](docs/recipes.md) documents the format and the loops. No migration.
- **Bulk journey enrollment by segment (#148).** `journeys.enrollSegment` enrolls a published segment into a published journey in chunks of 500 instead of paging up to 1,000 profile ids per `journeys.enroll` call. Each run is a visible job (`journeys.enrollmentJob`, `journeys.enrollmentJobs`) with a resumable cursor, entered/skipped/failed counts and why people were skipped (re-entry, missing profile, no lawful basis, suppression); an optional `limit` caps the audience and an idempotency key returns the same job. Re-entry, consent and suppression are checked per person, `journeys.cancelEnrollment` stops a queued or running job, and the impact is the segment's people capped by `limit`, so the audience threshold and mandate scopes decide for agents (above the threshold the call is refused with the reason, as for `journeys.enroll`). Migration `0060_enrollment_jobs.sql`; see [docs/architecture/journeys-and-editors.md](docs/architecture/journeys-and-editors.md#bulk-enrollment-by-segment-148).
- **Newsletter editor programme (#316).** The pilot's loop as a programme: the article library and selections (#140) and the approved briefs of the topic backlog (#141) feed a weekly issue sent with a subject test and a staged send under the mandate, followed by a report and a learning from the test. The Newsletter agent mandate template gains the `broadcastHoldout` learning rule; a hosted-agent template and an MCP recipe run the loop.
- **Lifecycle optimiser programme (#313).** A mandate template (docs/agents.md), an MCP recipe and a hosted-agent template that read each journey split against its holdout with `journeys.splitResult`, promote winners and retire losers by publishing a new journey version within the mandate, propose the next variant and record learnings.
- **Results per arm of a journey split (#313).** `journeys.splitResult` reports, for a split node, how many people took each arm, their goal conversions and unsubscribes, and each arm against the first with lift, a 95% interval and a verdict that needs the minimum sample in both arms. It is what the lifecycle optimiser promotes or retires a variant on.
- **Content sources and an article library (#140).** A workspace can add RSS, Atom and JSON Feed sources and fetch them on a schedule or on demand. Fetching uses the egress guard (public addresses only), conditional GET with ETag/Last-Modified, a bounded time and size, retries with backoff, and a consecutive-failure count that is visible in `content.sources.list`; a failing source never stops the others. Items are normalised to a canonical link, title, excerpt and author — never the full article — deduplicated across sources by canonical URL and title similarity, and scored deterministically by keyword groups, source authority, recency and category, with the section and every score component stored for each item. `content.selections.create` snapshots chosen items per section into a named, dated, versioned selection that an agent can propose as a draft and a person can read back. Agents may read sources, items and selections and create draft selections; adding or changing a source is people-only like connector configuration. Migration `0058_content_sources.sql`; see [docs/content-sources.md](docs/content-sources.md).
- **Editorial topic backlog and content briefs (#141).** A workspace-scoped topic backlog with the statuses idea → scored → brief → approved → drafting → published (and archived at any point), scoring from the signals behind a topic (content-library items, community demand, manual ideas and past posts), and advisory dedupe on the normalised title/keyword that links a near-duplicate instead of silently creating it twice. `content.topics.list/create/update/score/archive` manage the queue, and `content.topics.toBrief` creates a `content_brief` artifact draft seeded from the topic and its content-item signals. A brief is a versioned artifact with thesis, audience, angle, sources, outline, do-nots, the Monday test and success measure; publishing it moves its topic to approved, it cannot be published without a thesis, audience, Monday test and a source or an explicit reason, and an archived topic keeps its brief and published URL. Agents may propose and score topics and draft briefs; only people approve, publish, assign an owner and archive. Migration `0059_content_topics.sql` adds the backlog; the admin UI adds a Topics page under Build with status, owner, tag and score filters, and briefs edit in the normal artifact editor. See [docs/content-briefs.md](docs/content-briefs.md).
- **Level 4, run the loop (#309).** A mandate may grant level 4 for a class when the workspace allows loops and the agent has earned it: 28 days of the class at level 3 without a guardian episode, or 28 days in shadow mode without a would-have-run decision people rejected. Publishing a mandate that grants level 4 without that record is refused with what is missing. At level 4 a new artifact of an allowed type is not held to the mandate's artifact list, so the agent can create within its programme; everything else (audiences, purposes, channels, limits, guardrails, learning rules, the guardian) still applies. A class in shadow mode may record level 4 at any time.

- **Agent reports (#310).** `agents.report` shows an agent's actions by class and decision, undos and guardian episodes, the outcomes of the broadcasts it published and the messages it sent, the journeys it published against their control groups, and its mandate goals measured on its own broadcasts, for any period; the agent page shows the last 30 days. Mandate `goals` are now part of the policy engine's view of the mandate.
- **Learnings (#311).** A small, inspectable store of conclusions with their evidence, e.g. "subject lines with a number win for this audience: 3 of 4 tests, +2.1 pts". Each learning has a statement, an optional scope (audience segment ids, channel, topic, purpose), the experiment or holdout behind it and its author. `learnings.add` is available to people and agents (an agent's evidence must reference a real broadcast, journey, campaign or experience), `learnings.list` filters by status and scope, and `learnings.retract` lets a person withdraw one with a reason. Agents read the active ones as the MCP resource `learnings://current`, like `business-context://current`.
- **Agents subscribe to events instead of polling (#312).** `agents.subscribe` gives an agent the event types its loop reacts to — a hold that ran, was vetoed or now needs a person (`hold.ran`, `hold.vetoed`, `hold.needs_person`), an approval decided, a guardian episode or guardrail breach, an experiment reaching a significant verdict, and an alert firing — with an optional filter on subject ids and an optional outbound webhook. A subscription with a webhook gets each event as a signed, retried Standard Webhooks `POST` through the existing delivery worker; every event is also recorded and read with `agents.events` since a cursor, which is the fallback for MCP clients (the MCP server is stateless and cannot push notifications). `agents.unsubscribe` and `agents.subscriptions` manage them; an agent can only manage its own, a person any agent. Events carry ids, a type, a time and a short summary, never personal data. Migration `0057_agent_subscriptions.sql` adds the subscriptions, the per-workspace source cursor and the event log.

### Fixed

- **Undo is offered only when it would work (#305).** `agents.activity` checks each recorded reversal against the current state and reports `undoable: false` with `undoBlockedBy` when newer work went live, the artifact is no longer live, or the send already went out; the agent page shows that reason instead of an Undo button.

### Upgrading from 0.5.5

- **Migrations:** `0056_learnings.sql`, `0057_agent_subscriptions.sql` (with the agent event log and cursor), `0058_content_sources.sql`, `0059_content_topics.sql` and `0060_enrollment_jobs.sql`. All additive; they run on start.
- **Configuration:** none. Content sources are fetched only once a person adds one; their requests go through the existing egress guard.
- **Breaking changes:** none. Level 4 stays unavailable until a workspace allows loops (`allowLoops`, ceiling 4) and an agent has earned it. The "Campaign drafter" mandate template in docs/agents.md is now "Campaign agent".
- **Manual steps:** none. To run the newsletter programme, publish the Newsletter agent mandate with its new `learning` rule and use the **Newsletter editor** hosted-agent template, or follow the recipe from an external agent.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.5.5] - 2026-10-31

### Fixed

- **Event workers no longer stall silently (#307).** The 0.5.4 retry for failed fetches now tells errors apart: a missed heartbeat or timeout is retried with a growing pause, a consumer that no longer exists is created again, and an authorization error or 20 failures in a row stop the worker, so the process restarts instead of retrying forever while no events are processed.
- **Deliberate holdouts are not canary failures (#306).** A staged send's canary leaves out people a campaign control group holds out and readers a send window skipped, so a staged broadcast in a campaign with a control group, or with a send window, no longer stops without a single failed send.

### Upgrading from 0.5.4

- **Migrations:** none.
- **Configuration:** none.
- **Breaking changes:** none. An event worker whose fetches keep failing (an authorization error, or 20 failures in a row) now stops so the process restarts, as before 0.5.4, instead of retrying forever.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.5.4] - 2026-10-31

### Fixed

- **A canary that could not deliver stops the send at any size (#300).** A staged send's canary is waited for until it has gone out and is stopped when half or more of it failed or was suppressed, also when it is smaller than `minCanary`; only the "too few sends to judge the rates" skip still depends on its size.
- **Agent actions from before 0.5.2 are no longer offered for undo (#301).** `agents.activity` reports them as not undoable, so the agent page shows no Undo button for what `agents.undo` would refuse.
- **An event worker survives a failed fetch.** A pull from NATS JetStream that fails, e.g. with "heartbeats missed" while the host is busy, is logged and retried instead of stopping the ClickHouse sink or a profile worker (which only came back with a restart). Unacknowledged events are re-delivered as before.

### Upgrading from 0.5.3

- **Migrations:** none.
- **Configuration:** none.
- **Breaking changes:** none. A staged send whose canary is mostly undeliverable now stops at any canary size.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

## [0.5.3] - 2026-10-31

### Fixed

- **Undo refuses agent actions recorded before 0.5.2 (#291).** Their undo records do not say which version the agent published, so `agents.undo` cannot tell whether newer work went live since; it now asks a person to reverse them by hand instead of skipping the check.
- **A pause stops a config.import in progress (#292).** Every policy decision re-reads the agent's status, including the publishes inside one import, so the rest of the bundle is refused after a pause.
- **config.import approvals reach the shadow report (#293).** Its publishes record the approval they create, like `artifacts.requestPublish`.
- **A retry with the same idempotency key does not use the daily message limit again (#294).** A direct send whose key was already used counts as nobody, both in the policy decision and in the ledger.
- **The AI usage page filters independent checks and hosted runs (#297).**
- **A canary that could not send stops the staged send (#295).** The canary check needs successful sends, not just canary message rows: once nothing is in flight and the canary has too few successful sends to judge — because its messages failed or were suppressed — the stage and the run become `stopped`, the stop reason says how many canary messages failed or were suppressed, and nobody else is sent until a person runs `broadcasts.continue`. A canary that is genuinely smaller than `minCanary` still skips the check.
- **A hosted agent run cannot exceed its token allowance by a whole step (#296).** `maxTokensPerRun` is now a hard limit: before each model step the allowance still left is known, that step's `maxOutputTokens` is capped to it (a 100-token run can no longer ask for the old 200-token minimum), and no step starts when too little is left for a useful answer. A step's input tokens cannot be capped, so a run can still go over its allowance by the input of its last step — not by a whole further step. The tokens of the steps that finished are also recorded in `ai_calls` (and in the month's usage) when a later step throws, instead of 0.

### Upgrading from 0.5.2

- **Migrations:** none.
- **Configuration:** none.
- **Breaking changes:** none. `agents.undo` now refuses agent actions recorded before 0.5.2 and asks a person to reverse them by hand; a staged send whose canary could not deliver now stops instead of sending the rest.
- **Manual steps:** none.
- **Upgrade:** download `agentic-marketing-compose-<version>.tar.gz`, replace `docker-compose.yml` with its copy, check your configuration with the new image (`AM_VERSION=<version> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`), then set `AM_VERSION=<version>` in `.env` and `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

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
