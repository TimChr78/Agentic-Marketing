# Agentic Marketing

An open-source, self-hostable marketing platform built **agent-first**: every capability is a command that works the same over REST, MCP (for AI agents) and the web UI, under the same permissions, approvals and audit log. Underneath is an event-based customer data platform with GDPR-grade consent handling. You bring your own LLM keys.

It runs as one Docker image (a TypeScript modular monolith) next to Postgres, ClickHouse, NATS and Valkey, and is sized for a team of one up to a few million profiles.

## What it does

![The approval drawer: the agent's e-mail rendered for review](docs/design/screenshots/approval-email-1440-light.png)

- **An admin UI built for reviewing agents' work:** an approval drawer that shows the actual e-mail, form, journey, segment or broadcast with what changed and who asked; a journey builder with drag and drop; template, form, segment and brand editors; an asset library; light and dark themes; keyboard access throughout. Screens are in [docs/design/screenshots](docs/design/screenshots).

- **Collect events:** Segment-compatible ingest (`/v1/batch`), a browser SDK, per-source consent rules, a tracking plan, bot filtering.
- **Consent banner:** in the SDK, CSP-safe, with texts from your purposes and Google Consent Mode v2 signals. Ad click ids (`gclid`, `fbclid`, `msclkid`…) are kept only with `ad_measurement` consent.
- **Know people:** identity resolution and merges, profiles with traits and events, a consent ledger per purpose, export and erasure (DSR). A restore replays erasures and tombstones, so a backup cannot bring an erased person back.
- **Segments:** conditions on traits, events, consent and other segments, recomputed continuously, with enter and exit events. Whole-segment refreshes run as SQL in Postgres and ClickHouse, load-tested to a million profiles. A segment can also be a static list (added by hand, by id or e-mail, or imported from CSV) or a snapshot of another segment.
- **E-mail:**
  - MJML and Liquid templates with preview, test sends and UTM tagging;
  - a send gateway that checks lawful basis, consent, objections and suppressions;
  - providers SES, Postmark, Brevo, Cloudflare Email Service or SMTP, with delivery, bounce, complaint and click events;
  - a domain check for SPF, DKIM and DMARC;
  - one-click unsubscribe (RFC 8058).

  What happens to an e-mail becomes a customer event (`Email Link Clicked`…), so segments, journeys and webhooks can use it.
- **SMS:** Twilio, with consent per purpose, STOP/START/HELP replies, delivery reports, a segment and cost preview, and a monthly budget. SMS works in journeys and broadcasts.
- **Push:** web push (VAPID, encrypted payloads) for browsers, FCM for Android and APNs for Apple apps, with the same consent and delivery policy; in journeys and broadcasts.
- **Delivery policy:** for marketing messages on every channel:
  - frequency caps;
  - quiet hours in each person's time zone;
  - an automatic pause when bounce or complaint rates pass the limits.
- **Newsletter:** signup forms with double opt-in (works without JavaScript, optional Cloudflare Turnstile), subscriber import with consent proof (from Kit, Mailchimp…), broadcasts to a segment. Issues are built from reusable e-mail blocks and checked before they go out; readers choose topics on a preference centre; every issue has a signed web version and can go into a public archive with RSS; subject tests pick the winning subject line; send windows hold each message until the reader's local window opens.
- **Editorial:** RSS, Atom and JSON Feed sources fetched on a schedule into a scored, deduplicated article library with versioned selections; an editorial topic backlog (idea → scored → brief → approved → drafting → published) whose signals seed versioned content briefs ([content sources](docs/content-sources.md), [content briefs](docs/content-briefs.md)).
- **Recipes:** installable loops — a welcome journey with double opt-in, a lead-magnet drip, the weekly newsletter and a win-back journey — as versioned recipes whose installs are drafts for the normal approval path ([recipes](docs/recipes.md)).
- **Campaigns:** groups broadcasts, journeys, templates, experiences, forms and segments under one goal and a shared UTM campaign, with an attribution window, per-member results and a campaign report. Journeys and campaigns can hold out a control group and report the measured uplift. A campaign can start from an approved `campaign_brief`: `campaigns.plan` returns the drafts it would create and `campaigns.fromBrief` creates them without publishing anything.
- **Measurement and alerts:** a read-only metric layer (`analytics.query`, named reports, Insights → Analytics) answers questions over a fixed catalogue of measures and dimensions, with no SQL or table names as input. Threshold alerts watch deliverability, signup drops and journey errors, and notify a signed webhook or workspace members by e-mail.
- **Journeys:** a visual builder and an engine with waits, branches, e-mail, SMS, push, webhooks, connector actions and AI steps (decide, generate) with fallbacks; a wait-until step holds a person until a segment condition matches, an event trigger can enter people once per business key, and people can be moved onto a new version. A published segment can be enrolled in bulk in chunks as a resumable job, and a split reports each arm's conversions and lift against the first (`journeys.enrollSegment`, `journeys.splitResult`).
- **Web personalization:** experiences and A/B tests served by a decision API (or at the edge, by a Cloudflare Worker), with an anti-flicker snippet, consent-aware targeting, a visual composer, preview links and sequential or Bayesian results.
- **AI:** your own providers (Anthropic, OpenAI, Ollama…), metering and budgets that hold under concurrency, prompt artifacts with test runs, redaction, a decision log with sampled human reviews, text classification, generated text cached per segment, and an in-app copilot over MCP that streams its answers and keeps conversations.
- **Agents:** every API token and connected MCP client is an agent with a sponsor, a pause switch, workspace ceilings, per-agent limits and an action ledger; one policy engine classifies each write, estimates its impact and decides it ([docs/agents.md](docs/agents.md)).
  - **Mandates and autonomy:** a person grants an agent a scope, limits, guardrails, working hours and a period at levels 0–4 — observe, propose, act with veto (a hold with a veto window), act within limits, run the loop. Level 4 is earned by 28 days at level 3 without a guardian episode, or 28 days in shadow mode without a would-have-run decision people rejected; an optional second model checks each autonomous action.
  - **The safety net:** a guardian caps, holds or pauses an agent on a guardrail breach or an anomaly; a broadcast can send a canary share first and stop above its bounce, complaint or unsubscribe thresholds; reversible agent actions can be undone; shadow mode records what the agent would have done; learning rules require holdouts.
  - **Hosted agents:** the platform runs an agent itself on a schedule (a weekly report, the deliverability guardian), one fresh session per run under its mandate, with token and tool-call budgets.
  - **Reports, learnings and events:** `agents.report` answers what an agent did and what it achieved per period; conclusions live in a learnings store agents read as `learnings://current`; agents subscribe to holds, approvals, guardian episodes, experiment verdicts and alerts, delivered as signed webhooks or read from `agents.events`.
  - **Programmes:** the newsletter editor, campaign agent, lifecycle optimiser, experimentation agent and audience curator ship as mandate templates, hosted-agent templates and recipes, not hard-coded features.
- **Performance marketing:**
  - conversions to Meta (Conversions API), Google Ads (Data Manager API), Microsoft Advertising, LinkedIn, TikTok and Pinterest, from a conversion map, for people who allowed `ad_measurement`;
  - segments synced to Meta custom audiences and Google Customer Match, with `ad_targeting` consent and removals when people leave, withdraw or are erased;
  - spend import with CPA and ROAS per campaign from first-party attribution.

  Identifiers are hashed, test modes are built in, and uploads are listed in each person's data export. Agents read and draft; budgets and bids stay with people.
- **Integrations:**
  - signed outbound webhooks;
  - a connector SDK (Shopify, Slack, HTTP, and OAuth 2.0 APIs with automatic token refresh);
  - inbound hooks;
  - API tokens (for n8n and scripts);
  - warehouse export to Postgres or S3-compatible storage (for BigQuery, Snowflake…), without personal data, with erasures;
  - rate limits shared across workers.
- **Governance:**
  - everything an agent builds is a versioned artifact (journey, segment, template, form…) with drafts, diffs and approval policies;
  - config as code: artifacts in git, promoted from staging to production through the same approvals;
  - workspace portability: `config.export` can include workspace settings, `config.drift` compares a bundle with the workspace, and `config.import` into an empty workspace clones the artifacts and settings;
  - Prometheus metrics at `/metrics` (off unless `METRICS_TOKEN` is set): process, HTTP, command, queue and agent-decision series and dependency health, without workspace, person or address labels;
  - single sign-on (OIDC, SAML) and SCIM provisioning;
  - audit log;
  - encrypted secrets with key rotation, the key in the environment, OpenBao/Vault or AWS KMS;
  - Postgres row-level security and ClickHouse row policies per workspace;
  - retention jobs.

## Quick start (Docker)

Download `agentic-marketing-compose-<version>.tar.gz` from the [latest release](https://github.com/TimChr78/Agentic-Marketing/releases) (no checkout needed), then:

```bash
tar xzf agentic-marketing-compose-<version>.tar.gz && cd agentic-marketing-compose-<version>
# writes .env with generated secrets (never printed) and asks for the public URLs
docker run --rm -it -v "$PWD:/work" -w /work --user "$(id -u):$(id -g)" \
  ghcr.io/timchr78/agentic-marketing:<version> am init
docker compose up -d        # pulls the released image
docker compose exec app am bootstrap --email you@example.com --workspace 'My site'
docker compose exec app am doctor   # configuration, services, sending domains
```

In a checkout, `pnpm --silent --filter @agentic-marketing/server cli init` does the same. Never edit `docker-compose.yml`: site-specific settings go in `compose.override.yaml` (see [`compose.override.example.yaml`](compose.override.example.yaml) and [the Compose guide](docs/deployment/compose.md)), so an upgrade replaces the release file and nothing else.

`AM_VERSION` (default `0.7.0`) selects the released image `ghcr.io/timchr78/agentic-marketing`. Pin a version instead of `latest` so restarts and `docker compose pull` do not silently change what runs. `AM_PORT` (default `3000`) is the published host port: the app still listens on 3000 inside the container, so keep `PUBLIC_URL` and `PUBLIC_LINKS_URL` in step with it. ClickHouse is capped at `CLICKHOUSE_MEM_LIMIT` (default `2g`), which covers the whole container (server, caches and query memory); ClickHouse's own limits such as `max_server_memory_usage` still apply inside it, and 2g is a starting point for the single-node pilot.

To build from source (development, CI or a local patch) use the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

It tags the local image `agentic-marketing:local` (set `AM_BUILD_IMAGE` for another tag); the default compose file only pulls the release image.

The bootstrap command prompts for the password without echoing it. In a script, set `AM_BOOTSTRAP_PASSWORD` and pass it through (`docker compose exec -e AM_BOOTSTRAP_PASSWORD app am bootstrap …`) or pipe one line on stdin (`… | docker compose exec -T app am bootstrap …`). `--password` still works but is deprecated: arguments are visible in process listings and shell history. Change the password later with `am reset-password --email you@example.com` (again via `AM_RESET_PASSWORD`, a hidden prompt, or stdin).

Open http://localhost:3000 for the admin UI (it is built into the image and served at `/`), sign in, and add an e-mail provider. To let an AI agent work in the workspace, connect an MCP client (Claude, an IDE…) to `http://localhost:3000/mcp`: it registers itself, and you choose its permissions on the consent page.

MCP requires `PUBLIC_URL` to be HTTPS. With a plain-HTTP address on a LAN the admin UI and REST API still work, but MCP/OAuth client endpoints are disabled; expose the server over HTTPS (e.g. with Tailscale or a Cloudflare Tunnel) to enable MCP.

Running it behind a proxy or a Cloudflare Tunnel: set `PUBLIC_URL`, `PUBLIC_LINKS_URL`, `CLIENT_IP_HEADER` (an ordered list, e.g. `cf-connecting-ip,x-forwarded-for`) and `TRUSTED_PROXY_CIDRS` for the tunnel/proxy ranges (see [`.env.example`](.env.example)). With the ranges set, a multi-value `x-forwarded-for` is read from right to left past trusted hops, so a client cannot prepend a spoofed address. Set `PUBLIC_PORT` (e.g. `3001`) to add a public-only listener (`/f`, `/u`, `/c`, `/a`, `/n`, `/hooks`, `/healthz`, `/readyz`) and point the tunnel there, so no path rule is needed: a tunnel on the Compose network uses `http://app:3001`; for one on another host, publish it with `PUBLIC_BIND=0.0.0.0:3001`. Admin LAN traffic without a forwarding header uses the socket address.

The compose file keeps Postgres, ClickHouse and NATS data in named volumes. To use host directories instead, add bind mounts in `compose.override.yaml` (see `compose.override.example.yaml`, never edit `docker-compose.yml`). The containers run as their own users (Postgres uid 70 in the Alpine image, ClickHouse uid 101; NATS runs as root), so `chown` the host directories to match or the services will fail to write; named volumes avoid that.

On Kubernetes: the Helm chart in [`deploy/helm`](deploy/helm/agentic-marketing) runs each role as its own Deployment; see the [reference deployment](docs/deployment/kubernetes.md).

## Documentation

- [Agents](docs/agents.md): connecting an agent over MCP or REST, the workspace's limits, and mandates with autonomy levels and templates by role.
- [Editorial topics and content briefs](docs/content-briefs.md): the backlog, signals and dedupe, briefs as versioned artifacts, and the agent guardrails.
- [Development](docs/development.md): layout, running locally, tests, key rotation.
- [Kubernetes reference deployment](docs/deployment/kubernetes.md): Helm, OpenBao or AWS KMS keys, sizing.
- [Docker Compose deployment](docs/deployment/compose.md): the release files, the override file, upgrades.
- [Operations](docs/deployment/operations.md) (`am init`, `am doctor`), [backups and restore](docs/deployment/backups.md) and [post-upgrade checks](docs/deployment/smoke.md) (`am smoke`).
- [Edge decisions](docs/deployment/edge.md): the decision API on Cloudflare Workers.
- [Push notifications](docs/push.md): browsers, Android and Apple apps.
- [Decision models](docs/decision-models.md): TypeSafe JEV/System One scores, the decision journey node, the no-personal-data default and calibration.
- [Single sign-on, SCIM and agent permissions](docs/identity.md).
- [Architecture](docs/architecture/README.md) and its [ADRs](docs/architecture/adr/).
- [Integrations](docs/integrations.md): webhooks, connectors, n8n, config as code, warehouse export.
- [Content sources](docs/content-sources.md): RSS/Atom/JSON feeds, the scored article library, dedupe and versioned selections.
- [Recipes](docs/recipes.md): installable welcome/DOI, lead-magnet drip, newsletter and win-back loops, the recipe format, and the draft-only install path.
- [Pilot: MartechSignal](docs/pilots/martechsignal.md): replacing Kit on a static Cloudflare Pages site.
- Agent skills in [`.claude/skills/`](.claude/skills/):
  - `agentic-marketing-implement`: rolling the stack out on a website;
  - `agentic-marketing-mcp`: operating a workspace over MCP.

## Releases and upgrading

Releases are on [GitHub](https://github.com/TimChr78/Agentic-Marketing/releases), with the image `ghcr.io/timchr78/agentic-marketing:<version>` (linux/amd64 and linux/arm64), the packaged Helm chart, the Compose bundle (`docker-compose.yml`, `.env.example`, `compose.override.example.yaml`, [`UPGRADING.md`](UPGRADING.md)) and `SHA256SUMS`; what changed is in the [changelog](CHANGELOG.md). `/healthz`, MCP `serverInfo`, OpenAPI, `workspace.get` and Settings → Workspace show the running version. The current release is the **0.6** line; the [latest release](https://github.com/TimChr78/Agentic-Marketing/releases/latest) names the exact version. A release is made by pushing a version tag, or by running the Release workflow (Actions → Release → Run workflow) with the version, which tags the current `main`.

Upgrading: follow [UPGRADING.md](UPGRADING.md), and read the release's **Upgrading from** block, which always lists migrations, configuration, breaking changes, manual steps and the one-line upgrade. Database migrations run when the server starts, and only move forward: the app takes a Postgres backup to the `backups` volume before it migrates (unless `SKIP_PRE_UPGRADE_BACKUP=true`), and `am backup` / `am restore` do it by hand ([backups](docs/deployment/backups.md)). With `SKIP_MIGRATIONS=true` (several replicas, Kubernetes) run `am migrate` first; the Helm chart does this in a Job before each upgrade. After an upgrade, `am smoke --public-url <public URL>` checks the public host the way visitors and agents see it. While the version is 0.x, commands and artifact formats may still change.

Security problems: see [SECURITY.md](SECURITY.md).

## Status and roadmap

Wave 1 (Phases −1 to 5) is complete: foundations, data platform, e-mail, segments, journeys, personalization, AI and integrations.

[Wave 2](docs/architecture/roadmap-wave-2.md):

| Phase | Theme | State |
|---|---|---|
| 6 | Pilot live and hardening | The code items are done: e-mail events on profiles, retention, UTM tagging, test sends, Docker smoke test. 0.2.0 replaced the admin UI (navigation, approvals, journey builder, assets, brand). MartechSignal has run the platform since 0.2.2; the roadmap's four-consecutive-Fridays criterion is not recorded. |
| 7 | Delivery beyond SMTP, and SMS | Done in 0.1.0: Cloudflare Email Service adapter, delivery policy (caps, quiet hours, auto-pause), deliverability health and domain check, Twilio SMS. Later: GatewayAPI, SMS double opt-in, provider warm-up |
| 8 | Consent everywhere | Done in 0.1.0: consent banner with Consent Mode v2, ad purposes, click-id capture, OAuth 2.0 connections, shared rate limits, bot filtering |
| 9 | Performance marketing | Done in 0.1.0: conversions (Meta, Google, Microsoft), audience sync (Meta, Google), spend and ROAS. Later: Microsoft reporting and audiences, more platforms |
| 10 | Scale and operations | Done in 0.1.0: correctness (AI budget reservations, prompt test jobs, merge-safe journeys, journey version migration, instant experience updates), scale (segments evaluated in SQL, ClickHouse row policies, a load test to 1M profiles), operations (Helm chart, OpenBao and AWS KMS keys, warehouse export, config as code) |
| 11 | Enterprise and ecosystem | Done in 0.1.0: part a (single sign-on with OIDC and SAML, SCIM provisioning, MCP scope step-up), part b (AI: classify, text per segment, review samples, a streaming copilot with stored conversations), part c (sequential and Bayesian experiment statistics, edge decide on Cloudflare Workers, a visual composer and preview links), part d (push: web push, FCM, APNs), part e (Salesforce, the Shopify app with customer import, conversions to LinkedIn, TikTok and Pinterest) |

[Wave 3](docs/architecture/roadmap-wave-3.md), from the open issues:

| Phase | Theme | State |
|---|---|---|
| 12 | Install and upgrade | Done in 0.2.4–0.2.5: Compose bundle per release, compose defaults, `am init` / `doctor` / `smoke`, backups and restore, the running version everywhere |
| 13 | Pilot correctness | Done in 0.2.6: consent exits from journeys, approval bundles, fast confirmation retries, layout-only journey edits |
| 14 | Admin UI for daily use | Done in 0.2.7: pages use the window, live journey stats, structured editors, server-side list filters |
| 15 | Newsletter and lifecycle e-mail | Done in 0.2.8: preference centre, archive and web version, content blocks, pre-send checks, subject tests, send windows, static audiences, wait until and entry keys |
| 16 | Measure and report | Done in 0.2.9: metric layer, campaigns, holdouts, alerts |

[Wave 4](docs/architecture/roadmap-wave-4.md), agentic marketing (designed in [agentic-autonomy.md](docs/architecture/agentic-autonomy.md)): agents that run whole marketing loops within borders a person sets, enforced by the platform.

| Phase | Theme | State |
|---|---|---|
| 17 | Agent controls | Built in 0.3.0: agents as principals with a pause button, a policy engine with limits and impact estimates, the action ledger, Settings → Agents (still open: #207, strict inputs as the default). The erasure-safe restore (#144) shipped in 0.5.0 |
| 18 | Mandates and the first autonomy | Built in 0.4.0: mandates with levels 0–3, holds with veto windows, the independent check, notifications, business context ([docs/agents.md](docs/agents.md)); the four-week pilot mandate is pending |
| 19 | The safety net | Built in 0.5.0: the guardian, staged sends, undo, shadow mode, learning rules and thin hosted agents, plus Prometheus metrics, workspace portability and erasure-safe restores. The test-workspace and pilot checks are pending |
| 20 | Closed loops | Built in 0.6.0: level 4, agent reports, learnings, agent events, the campaign agent and briefs, the newsletter, lifecycle, experimentation and audience programmes, content sources and briefs, recipes and bulk enrollment. The month-long programme runs are pending |
| 21 | Hosted agents and decision models | Built in 0.7.0: event-triggered hosted runs, the copilot acting as an agent, hosted-agent memory and skills, decision models (JEV through System One: `ai.score`, stored scores, a journey decision step, calibration), password reset, backup key checks and verification, mjml 5. The thin runtime shipped in 0.5.0. The live decision-model gate is pending |
| 22 | Many agents, many brands | Planned: coordination, brand scoping, progressive rollout, ad audiences (agent-managed spend needs its own design, #212) |

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # tests need Postgres, ClickHouse, NATS and Valkey
scripts/smoke.sh                           # the Docker image end to end
pnpm --filter @agentic-marketing/server cli loadtest --profiles 1000000   # segment refreshes at scale
pnpm dev:web                               # the admin UI on :5173 against the API (demo at /demo)
npx tsx apps/server/test/e2e/server.ts     # a seeded workspace on :3100 for UI work
pnpm e2e                                   # Playwright end-to-end tests of the UI
```

See [docs/development.md](docs/development.md) for details.

## License

[MIT](LICENSE).

