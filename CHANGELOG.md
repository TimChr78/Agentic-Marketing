# Changelog

All notable changes to Agentic Marketing. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, minor versions may change the commands API, the configuration and the artifact formats, and the notes say how to move.

## [Unreleased]

Phase 12 of [wave 3](docs/architecture/roadmap-wave-3.md#phase-12-install-and-upgrade): installing, upgrading, checking and restoring the platform without a checkout or local edits. REST and MCP stay backwards compatible: `workspace.get` gains one output field. No migration.

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

- **Migrations:** none.
- **Configuration:** new, all optional: `PUBLIC_BIND` (default `127.0.0.1:3001`, Compose only), `SKIP_PRE_UPGRADE_BACKUP` (default `false`), `BACKUP_DIR` (set to `/backups` by Compose), and for the backup service `BACKUP_CRON` (default `30 3 * * *`) and `BACKUP_KEEP_DAYS` (default 14). `docker-compose.yml` adds the `backups` volume.
- **Breaking changes:** none in REST, MCP or artifacts. Compose: the public listener's port is now always published (loopback-only by default), so host port 3001 must be free, or set `PUBLIC_BIND`.
- **Manual steps:** if you edited `docker-compose.yml`, move those edits into `compose.override.yaml` before replacing the file. If you uncommented the public listener's port line, remove that edit; `PUBLIC_BIND` replaces it. Optionally add the `backup` service from `compose.override.example.yaml`.
- **Upgrade:** set `AM_VERSION=<version>` in `.env`, replace `docker-compose.yml` with the bundle's copy, then `docker compose pull && docker compose up -d` (Helm: the chart of the same version). Then `docker compose exec app am doctor`.

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
