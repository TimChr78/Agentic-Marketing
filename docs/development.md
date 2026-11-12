# Development

## Layout

```
packages/
  core/        ids (UUIDv7, prefixed), AppError, canonical JSON hashing, time and network helpers
  db/          SQL migrations and runner, Drizzle schema, owner and row-level-security pools
  commands/    command registry: defineCommand, permissions/roles, executor (validate → authorize → idempotency → audit), policy and undo
  artifacts/   versioned artifacts and their content schemas (table below), approvals, diffs, bundles, holdouts, hosted pages, agent mandates, learnings, content topics and the recipe gallery
  secrets/     envelope encryption (KEK → per-workspace data keys), key providers, write-only secret commands
  auth/        Better Auth (people), OAuth 2.1 for MCP clients, members, SSO and SCIM, API tokens, agents, hosted agents and agent events
  telemetry/   pino logger, optional OpenTelemetry tracing (OTLP)
  events/      NATS JetStream bus, ClickHouse event store and sink, event schemas
  ingest/      Segment-compatible ingest gateway, source write keys and consent policy
  hotstate/    Valkey session and profile snapshot for the decision API
  profiles/    profiles, identity resolution and merges, consent ledger, per-person encryption, event worker
  segments/    segment DSL, SQL compiler (Postgres + ClickHouse), streaming evaluator, static lists, snapshots and CSV import
  journeys/    journey graph model, interpreter, entry keys, wait-until, control groups, split results and bulk enrollment
  audience/    signup forms, broadcasts, hosted pages, newsletter archive, subscriber import, message events, retention
  email/       send gateway, provider adapters (e-mail, SMS, push), templates, blocks, rendering, checks, delivery policy
  campaigns/   campaign briefs, plan and from-brief drafting, campaign members, shared UTM campaign, control-group helpers
  personalize/ experiences, decision engine, A/B allocation and results, edge decide
  analytics/   read-only metric layer: query catalogue, named reports, campaign summary
  alerts/      threshold alert rules, five-minute evaluator, webhook and e-mail notifications
  ai/          LLM gateway and providers, prompt tests, AI steps, classification, copilot, context and redaction
  ads/         ad platform connectors and conversions, audience sync, click ids, spend import
  integrations/ connections, connector SDK, webhooks (in/out), OAuth, egress guard, Shopify import
  assets/      image and PDF asset library, SVG cleaning, PNG renditions, public asset routes
  content/     content sources (RSS, Atom, JSON Feed), normalised article items with an explainable score, versioned selections
  warehouse/   warehouse export datasets and destinations
  client/      typed REST client inferred from the command registry
  edge-worker/ the decision API as a Cloudflare Worker, reading Workers KV (docs/deployment/edge.md)
  sdk-js/      browser SDK: Segment-compatible tracking, consent banner, personalization and push
apps/
  server/      Hono app: REST (/v1/<command>, /openapi.json), MCP (/mcp), sign-in/consent, health; CLI
  web/         React admin UI (app/ shell and router, ui/ design system, features/, pages/) served at /; /demo runs the same shell on fixed sample data, read-only
spikes/        throw-away prototypes with their FINDINGS.md (not part of CI or the image)
scripts/       release bundle, smoke, config pull/push, version check and generated MCP tool docs
e2e/           Playwright specs, screenshots and the seeded server
deploy/        Helm chart
docs/          this documentation (architecture/, deployment/, design/, pilots/)
```

### Artifact types

Every type shares the generic artifact commands (draft, version, diff, publish, bundle) and its content
schema is validated on save. The source of truth is `artifactTypes` in
[`packages/artifacts/src/types.ts`](../packages/artifacts/src/types.ts); the ids carry the prefix.

| Type | Prefix | Holds |
|---|---|---|
| `note` | `not_` | Free-form note, used to exercise the artifact system. |
| `journey` | `jrn_` | Journey graph: trigger, steps, branches, control group. |
| `email_block` | `blk_` | Reusable MJML fragment with typed parameters. |
| `email_template` | `eml_` | MJML e-mail with Liquid, subject, preheader and purpose. |
| `sms_template` | `sms_` | Text message with Liquid and a purpose. |
| `push_template` | `psh_` | Push title, body, link and image with a purpose. |
| `segment` | `seg_` | Dynamic condition, static list or snapshot. |
| `experience` | `exp_` | Web experience: placement, variants, targeting, holdout and goal. |
| `prompt` | `prm_` | AI prompt for a journey step, with test cases. |
| `form` | `frm_` | Public signup form: purposes, double opt-in, allowed sites, redirects, Turnstile, optional hosted-page brand override. |
| `brand` | `brd_` | Brand for hosted pages and the newsletter archive; one per workspace. |
| `broadcast` | `bct_` | One send: template, segment, schedule, subject test, staged send, archive. |
| `campaign` | `cmp_` | Grouping of artifacts under one goal and UTM campaign, with a control group. |
| `tracking_plan` | `tpl_` | Accepted events and traits, personal data and agent visibility; one per workspace. |
| `purposes` | `pur_` | Lawful bases, channels and topics; one per workspace. |
| `conversion_map` | `cvm_` | Ad conversion rules; one per workspace. |
| `audience_sync` | `aud_` | A segment kept in sync with an ad platform's custom audience. |
| `delivery_policy` | `dlp_` | Frequency caps, quiet hours, auto-pause; one per workspace. |
| `agent_mandate` | `mnd_` | An agent's levels (0–4), scope, limits, guardrails and learning rules; people only. |
| `business_context` | `bcx_` | What the business offers, to whom, in which voice; one per workspace. |
| `campaign_brief` | `cpb_` | Contract for one campaign: goal, audience, message, schedule, holdout. |
| `content_brief` | `brf_` | Editorial brief for a topic: thesis, audience, sources, outline, Monday test. |
| `skill` | `skl_` | Named instructions a hosted agent can reference; only the published version is used. |

Adding a capability = one `defineCommand(...)` in a package + adding it to `apps/server/src/registry.ts`. The REST route, OpenAPI entry, MCP tool and typed client call follow automatically.

## Run locally

Requirements: Node 22+, pnpm 10, PostgreSQL 16, ClickHouse (26.8 LTS), NATS with JetStream (`nats-server -js`) and Valkey (or Redis), local or Docker. `CLICKHOUSE_URL`, `NATS_URL` and `VALKEY_URL` default to localhost.

```bash
pnpm install
cp .env.example .env          # fill AUTH_SECRET and MASTER_KEY (openssl rand -base64 32), point DATABASE_URL at Postgres; the passwords are hex (openssl rand -hex 32) because Compose puts POSTGRES_PASSWORD into DATABASE_URL raw
pnpm --silent --filter @agentic-marketing/server cli bootstrap --email you@example.com --workspace 'My shop'
pnpm dev                       # API on http://localhost:3000 (migrates on start)
pnpm dev:web                   # the admin UI on http://localhost:5173 (the demo is at /demo)
```

The production build is the same app, with the demo as a separate chunk at `/demo`:

```bash
pnpm --filter @agentic-marketing/web build:live   # writes apps/web/dist
pnpm dev                                          # serves that build at http://localhost:3000/
```

The Docker image runs `build:live` and copies `apps/web/dist` into place, so `/` is the admin UI. When the
directory exists the server serves real assets and falls back to `index.html` for extension-less paths; API
paths are never answered with the page. Set `WEB_DIST` to serve a different build (for example a mounted
volume); when the directory is absent the server runs API-only, as before.

`bootstrap` prompts for the password without echoing it. Non-interactively, set `AM_BOOTSTRAP_PASSWORD` for the command or pipe one line on stdin; `--password` still works but is deprecated because arguments are visible in process listings and shell history. `pnpm --silent --filter @agentic-marketing/server cli reset-password --email you@example.com` changes a password later, reading `AM_RESET_PASSWORD`, a hidden prompt or stdin.

`DATABASE_URL` must be a role that can create roles (the migration creates `am_app`, the row-level-security role the app uses, with `APP_DB_PASSWORD`).

Connect an MCP client (Claude, an IDE, …) to `http://localhost:3000/mcp`. It registers itself, you sign in and choose its permissions on the consent page.

MCP requires an HTTPS `PUBLIC_URL` (loopback HTTP is fine for local development). If the server starts with a plain-HTTP LAN address such as `http://192.168.1.20:3210`, it logs a warning and starts without the MCP/OAuth client endpoints; the admin UI and REST API keep working. Use an HTTPS URL (e.g. a Tailscale or Cloudflare Tunnel hostname) to enable MCP.

### Client IP behind two ingress paths

Public traffic and admin traffic often take different paths: visitors arrive through a Cloudflare Tunnel (which sets `cf-connecting-ip`), while admins sign in over the LAN or VPN (where that header is absent). List both headers in trust order, and name the proxies whose forwarding headers may be believed:

```bash
CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,10.0.0.0/8
```

`CLIENT_IP_HEADER` is an ordered, comma-separated list: the first header present is used. With `TRUSTED_PROXY_CIDRS` set, headers are ignored unless the socket address is in one of those ranges (bare IPs and CIDR ranges, IPv4 or IPv6). A multi-value header such as `x-forwarded-for` is then read from right to left, skipping addresses inside those ranges, and the first untrusted address is the client: an appending proxy leaves a client-supplied value on the left of the header, so only the right-hand side is trustworthy. A single-value header that the proxy overwrites (`cf-connecting-ip`, `x-real-ip`) is used unchanged. Admin LAN traffic has no forwarding header and falls back to the socket address. Empty `TRUSTED_PROXY_CIDRS` ignores forwarding headers entirely and uses the socket address, so a caller cannot choose its own rate-limit or audit IP; behind a proxy every client then shares the proxy's bucket, so set your tunnel/proxy and loopback ranges in production.

### Docker Compose

```bash
cp .env.example .env   # fill in the secrets
docker compose up -d   # the released image, as a self-hoster runs it
# or build the working tree (development, CI):
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose exec app am bootstrap --email … --workspace …
```

In a checkout `.env.example` is already in the tree, so copying it and filling in the secrets is enough; a release install runs `am init` from the released image instead, which writes `.env` with generated secrets ([compose](deployment/compose.md)).

The default file pulls `ghcr.io/timchr78/agentic-marketing:${AM_VERSION}` (pin the version in `.env`; `AM_PORT` changes the published port). The overlay builds this checkout and tags it `AM_BUILD_IMAGE` (default `agentic-marketing:local`); `scripts/smoke.sh` uses the same overlay. ClickHouse is capped at `CLICKHOUSE_MEM_LIMIT` (default 2g), which covers the whole container; ClickHouse's own `max_server_memory_usage` still applies inside it. To keep data in host directories instead of named volumes, see the README: the services run as their own users, so the directories need matching ownership and permissions.

`am` runs the server CLI without pnpm's banner. The command prompts for the password without echo; for scripts use `docker compose exec -e AM_BOOTSTRAP_PASSWORD app am bootstrap …` (or pipe one line with `docker compose exec -T`). `am reset-password --email …` (with `AM_RESET_PASSWORD`) sets a new password. `--password` is deprecated.

`scripts/smoke.sh` (also run in CI) does this end to end with a throw-away compose project: start, bootstrap, sign in, publish a signup form, and check its confirmation e-mail is sent.

### The admin UI

The UI follows [docs/design/DESIGN.md](design/DESIGN.md) (tokens, components, layout, accessibility); calls made
while building it are in [docs/design/DECISIONS.md](design/DECISIONS.md). `apps/web/src/ui` is the component set
(buttons, fields, drawers, modals, toasts, tables, tabs, menus, code and diff views), `app/` the shell, router,
session and the typed API client (`api.call('<command>', input)`), `features/` the larger parts (approvals,
previews, journey builder, providers, tokens, assets, brand) and `pages/` one file per route
(`app/routes.tsx`). Every page uses the same commands an agent would; hide actions with `can('<permission>')`.

A seeded server gives you a realistic workspace (a newsletter site with people in each role, an agent token,
published prerequisites and pending approvals of every reviewed type) without touching your own data:

```bash
pnpm --filter @agentic-marketing/web build   # writes apps/web/dist, which the seeded server serves
npx tsx apps/server/test/e2e/server.ts       # API + that build on http://localhost:3100, a fresh run-scoped e2e database
API_URL=http://localhost:3100 pnpm dev:web   # or the dev UI against it on :5173
```

People: `alex@example.com` (owner), `sam@example.com` (builder), `jo@example.com` (approver),
`vic@example.com` (viewer); password `correct-horse-battery-staple`. Set `TRUSTED_ORIGINS` if you use another
origin.

The seed (`apps/server/test/e2e/seed.ts`) also writes weeks of deterministic activity, so analytics, journey stats,
deliverability and agent reports are not empty: about 520 people with consent history, eight sent weekly issues with
delivery events, a scheduled and a stopped send, a live journey, a web-experience experiment, campaign conversions,
agent actions and a guardian episode, alerts with history and an import. It is generated from a seeded PRNG and a
fixed clock — `seed(t, { now })`, defaulting to `2026-11-02T09:00:00Z` — so the counts, rates and names are stable
across runs. Pass another `now` to move the history; the UI's date pickers are real time, so screenshots use the
default. Seeding takes about 15 seconds on a normal test machine.

Tests for the UI:

```bash
pnpm vitest run --project web                 # unit and component tests (jsdom)
pnpm e2e                                      # Playwright: builds the UI, starts the seeded server, runs the functional specs and the axe checks
pnpm e2e --project functional                 # only the functional specs
pnpm e2e --project axe                        # only the accessibility checks (WCAG 2.1/2.2 A and AA, every route)
pnpm e2e:visual                               # visual regression against the committed baselines
E2E_BASE=http://localhost:5173 pnpm e2e       # against a running dev UI and seeded server instead
CHROMIUM=/usr/bin/chromium pnpm e2e           # use a system Chromium instead of Playwright's download
pnpm shots                                    # screenshots of every admin route, light and dark, 1440/768/390 px
```

#### The browser suite in the CI image

`scripts/e2e-docker.sh` runs the same browser CI runs, from any checkout, without installing
Chromium: it builds the UI, starts the seeded server on a fresh database, waits for `/ready`, then
runs Playwright inside `mcr.microsoft.com/playwright:v1.64.1-noble` with the repository mounted at
its own path.

```bash
scripts/e2e-docker.sh smoke        # the @smoke subset: sign-in/Home, approvals, composer, editor, people, agent pause
scripts/e2e-docker.sh functional   # every functional spec
scripts/e2e-docker.sh axe          # the accessibility project
scripts/e2e-docker.sh visual       # visual regression against the committed baselines
scripts/e2e-docker.sh update       # re-record those baselines (review the diff, then commit)
scripts/e2e-docker.sh shots        # the full screenshot matrix in reports/shots
pnpm e2e:smoke                     # the same wrapper through package.json
```

Each run creates a fresh database under one `AM_TEST_RUN` namespace (generated for the invocation
unless you set it), and computes its exact name with `packages/db/test/print-db.ts` — the same
builder the harness and `test:clean` use. It passes `AM_TEST_RUN`, `TEST_DATABASE_URL`,
`CLICKHOUSE_URL`, `NATS_URL` and `VALKEY_URL` through to the server, verifies the seeded database
by that name, and drops only that database afterwards (`E2E_KEEP_DB=1` keeps it). An explicit
`E2E_DB` is refused when the database already exists, so a failed run can never drop someone
else's data. The port is `E2E_PORT`, or `3100 + TEST_PORT_OFFSET` from `e2e/ports.ts` when unset
(`E2E_PORT+1` is the fixtures port); this is the same offset Playwright and the helpers use. A run
refuses to start if either port is already in use and prints the holding process — the wrapper
never pattern-kills anything. Playwright's artifacts go to `test-results/<AM_TEST_RUN>`, so two
concurrent runs do not delete each other's traces. `E2E_SKIP_BUILD=1` reuses `apps/web/dist`.

The wrapper targets **Linux**, like the shared test stack: it needs `setsid` (util-linux) to give
the seeded server its own process group, and never relies on GNU-only `date` formats. macOS lacks
`setsid`, so the script fails before doing any work there.

The runner's Docker network comes from `E2E_DOCKER_NETWORK`: `host` by default, so the container
reaches the server on the host's loopback. When the script itself runs inside a container (there is
a `/.dockerenv`, or the cgroup names a container runtime), it resolves that container from
`$HOSTNAME` matched against both container names and ids, then from `/proc/self/mountinfo` and
`/proc/self/cgroup` when the hostname is custom, and uses `container:<name>` so the runner shares
that container's network namespace and `localhost:E2E_PORT` still reaches the server. If it cannot
resolve the enclosing container it fails and names `E2E_DOCKER_NETWORK`; it never falls back
silently to host networking. On this machine that makes
`E2E_DOCKER_NETWORK=container:T3-Code` unnecessary to set by hand.

The smoke selection is the `@smoke` tag on the tests themselves (`test(..., { tag: '@smoke' }, ...)`),
so `pnpm e2e --project functional --grep @smoke` runs it against a local dev server too. It is meant
to stay under about three minutes excluding the build and seed.

Label selectors follow #248: use `getByRole(role, { name, exact: true })` (or a `data-testid` where a
required field's accessible name includes a hidden asterisk), never a loose `getByLabel(...)` that can
match a second field. `scripts/check-e2e-selectors.mjs` (`pnpm e2e:selectors`, part of `pnpm lint`)
fails on any `getByLabel(` in `e2e/` without `{ exact: true }`.

#### Screenshots, visual regression and accessibility

The route matrix is one list, `e2e/matrix.mjs`: every entry in `apps/web/src/app/nav.ts` (read from
source, so a new nav item is covered without touching the script), the detail pages the seed
provides (one of each artifact type, a person, an agent, a token, every approval type), the signed-out
sign-in page and `/`. Everything below uses it.

- `e2e/screenshots.mjs` (or `pnpm shots`) writes the full matrix as PNGs:
  `node e2e/screenshots.mjs <outDir> [--only name,name] [--widths 1440,768,390] [--themes light,dark]`.
  Captures are deterministic: the clock is fixed at the seed's date, motion and carets are disabled,
  fonts and images are loaded and skeletons gone before the shot, and relative times, dates and raw
  ids are masked with Playwright (their text is replaced first, so a mask keeps its size when "9 min
  ago" becomes "1 d ago"). Pass `--no-mask` when the images are for people rather than for
  comparison: the masks are pink boxes, and the real clock is used, since the seeded artifacts carry the
  time the seed ran.
- `e2e/visual.spec.ts` compares a stable subset (sign-in, approvals and a broadcast approval, the
  journey list and builder, a broadcast, a template, people, analytics, agents and an agent, the
  workspace settings) at 1440 and 390 px in both themes against the baselines in
  `e2e/visual.spec.ts-snapshots`. A diff above `maxDiffPixelRatio: 0.002` fails. It expects a freshly
  seeded server: its config starts one, and with `E2E_BASE` point it at a server you have just
  started, because the functional suite changes the seeded data.
- `e2e/axe.spec.ts` runs axe-core over the whole matrix, light and dark at 1440 px, and fails on any
  violation that is not in `e2e/axe-known-issues.json`. Each entry names the axe rule, the route and
  why it is deferred; the wave's done criterion is an empty list. The run prints every violation by
  rule, including the known ones, so the list can shrink.

Baselines are Linux screenshots, so record and update them in the official Playwright container
(the same image CI uses) with the repository mounted at its own path and the seeded server running
on `localhost:3100`:

```bash
CH=$(docker run --rm mcr.microsoft.com/playwright:v1.64.1-noble sh -c 'ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -1')
docker run --rm --network host -v "$PWD":"$PWD" -w "$PWD" -e CHROMIUM="$CH" -e E2E_BASE=http://localhost:3100 \
  mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test -c playwright.visual.config.ts --update-snapshots
```

The same command runs the checks without `--update-snapshots`; swap the last argument for
`npx playwright test` (functional and axe) or `node e2e/screenshots.mjs reports/shots` to run those in
the container too, so a machine without a usable Chromium still gets the CI result.

Updating a baseline is a reviewed commit, never something CI does: look at the expected/actual/diff
images the failed job uploads as `visual-diffs`, decide whether the change is intended, and only then
re-record that route (`... --update-snapshots visual.spec.ts -g people`) and commit the new PNG.

### Collecting events

Add a source with `sources.create` (REST or MCP). Browser sources get a public write key and only accept their allowed origins; by default they keep an event only when the visitor allowed the `analytics` purpose. On a site, use `@agentic-marketing/sdk-js` (`packages/sdk-js`), or any Segment-compatible library pointed at this server (`/v1/batch`, write key as the Basic auth user name). Events show up on the person's profile within a couple of seconds; `ROLE` decides which processes run the `api`, `ingest` and `worker` parts (all by default).

### Personalizing the website

Mark elements with `data-am-placement="home_hero"`, put `antiFlickerSnippet()` from `@agentic-marketing/sdk-js` in the page head, and call `analytics.personalize()` after loading the SDK. Create a web experience for the placement (Build → Experiences, or `artifacts.create` with type `experience`); published experiences are served by `POST /v1/decide` within 30 seconds. Visitors who have not allowed `web_personalization` only get page-based targeting (page, referrer, UTM, device).

### AI providers and the copilot

Add a provider under Settings → Providers → AI with your own key. Base URLs:
- Anthropic: `https://api.anthropic.com/v1`
- OpenAI: `https://api.openai.com/v1`
- Ollama: `http://<host>:11434/v1` (turn off structured outputs if the server does not support JSON-schema responses)

Give it the uses `journeys` (AI steps and prompt tests) and/or `copilot`. Without a provider, AI steps take their fallback.

People must allow the `ai_processing` purpose for AI steps to use their data. Templates use generated text as `{{ content.<slot> }}`. Tests use a scripted LLM server (`@agentic-marketing/ai/testing`) instead of a real provider.

More from prompts:
- **Classify** (`kind: "classify"`, the `options` are the labels): `ai.classify {artifactId, text, profileId?}` queues the call and returns a `callId`; `ai.classification {callId}` gives the label within seconds. The text reaches the model as delimited data. With a person, their `ai_processing` consent is checked and, if the prompt names a `trait`, the label is stored on their profile (never into a trait the tracking plan marks personal). Useful from n8n, e.g. to sort e-mail replies.
- **Text per segment** (`cache: {segments, ttlHours}` on a generate prompt): the text is written once per combination of those segments, from the segment names alone, and reused for everyone in the same combination until it expires; the decision log marks reused answers `cached`.
- **Review samples** (`review: {sampleRate}`): that share of answered calls waits in `ai.reviews` for a person's verdict (`ai.review`, good or bad, with a note); `ai.reviews` also gives each prompt's share of good answers.
- **Copilot:** text streams in as the model writes it, and conversations are kept on the server per person (`copilot.conversations`, `copilot.conversation`, `copilot.deleteConversation`); only the last 20 turns go back to the model.

### Integrations

See [integrations.md](integrations.md) for API tokens, webhooks, connectors and n8n. Outbound calls only reach public addresses; allow LAN targets such as a homelab n8n with `EGRESS_ALLOWED_HOSTS=n8n.lan,192.168.1.0/24`.

### Agent skills

`.claude/skills/agentic-marketing-implement` (rolling the stack out on a website, with Cloudflare specifics) and `.claude/skills/agentic-marketing-mcp` (operating a workspace over MCP) load automatically in Claude Code sessions in this repo. To use them from a website's repo, copy both folders into that repo's `.claude/skills/`. The worked example is [pilots/martechsignal.md](pilots/martechsignal.md). How an agent connects, what the workspace allows by default and how a mandate grants more are in [agents.md](agents.md).

### Members

Owners and admins invite people with `members.invite` (UI, REST or the typed client; agents cannot). The response holds a one-time link, `<PUBLIC_URL>/invite#<token>`, valid for 7 days. Send it to the person; they sign in or create an account with the invited e-mail address and join with the invited role. Only owners can make or change owners, and the last owner can be neither demoted nor removed. `workspace.memberships` lists the workspaces a signed-in person belongs to with their role; REST clients switch by sending `X-Workspace-Id: <workspace id>` on later calls (the admin UI keeps the choice). A token or OAuth connection is bound to one workspace and sees only that one; the header is refused for it (#187).

### Rotating the master key

To keep the key-encryption key in OpenBao/Vault Transit or AWS KMS instead of `MASTER_KEY`, see [the Kubernetes guide](deployment/kubernetes.md#keys-master_key-openbao-or-aws-kms); `cli rotate-keys` moves existing data keys over.

Secrets are encrypted with per-workspace data keys, which are wrapped by `MASTER_KEY`. To rotate it:

1. Generate a new key (`openssl rand -base64 32`), set it as `MASTER_KEY`, and put the old one in `MASTER_KEY_PREVIOUS`. Restart; everything keeps working, and new data keys use the new master key.
2. Run `pnpm --filter @agentic-marketing/server cli rotate-keys` to re-wrap every existing data key with the new master key.
3. Remove `MASTER_KEY_PREVIOUS` and restart.

### ClickHouse row policies

Every ClickHouse table with a `workspace_id` has a row policy (`am_workspace`): a query sees only the rows of the workspace in its `SQL_workspace` setting, and none without it. The event store sets it on every query, so the policy backs up the workspace filters in code. Creating the policies needs a ClickHouse user with access management (`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` in the official image, as in `docker-compose.yml`) and the `SQL_` custom-settings prefix (in the image's default config). `CLICKHOUSE_ROW_POLICIES=required` (compose, CI) refuses to start without them, `auto` (default) applies them when it can, `off` removes them. To look at data by hand: `SELECT … SETTINGS SQL_workspace = '<workspace id>'`.

### API and MCP compatibility

Command names, inputs and outputs stay backward compatible: new fields are optional, and existing commands keep their meaning. Three settings control stricter API surfaces:

- `STRICT_INPUTS` (default `false`) is warn-first: unknown keys in a command's input are logged and returned as `warnings` in the result, so existing clients keep working. With `true`, they are rejected with `invalid_input` naming the offending key and the keys the command accepts. Roll it out by running with the default first, fixing clients that send typos, then turning it on.
- `MCP_TEXT_CONTENT` (default `json`) puts the full command result in an MCP tool result's text block. `summary` puts a one-line summary there instead (e.g. `artifacts.list: 12 artifacts`); `structuredContent` always carries the full result.
- `MCP_TOOL_NAME_STYLE` (default `dotted`) lists tools by command name (`artifacts.list`). `underscore` lists and accepts `artifacts_list` instead, for clients that reject dots; scope step-up works the same way. REST always uses the command name at `POST /v1/<command>`.

Every MCP tool advertises an object `outputSchema` and returns matching `structuredContent`, so clients can validate results.

### Load test

`pnpm --filter @agentic-marketing/server cli loadtest --profiles 1000000` seeds a throwaway workspace with synthetic people (traits, a user id, consent) and their events straight into Postgres and ClickHouse, refreshes five segments (trait, event count in a window, "never did", consent, and a combination with `not`) twice, checks every size against what the data implies, prints the timings and removes the workspace (`--keep` leaves it). Results are in [the reference deployment notes](architecture/roadmap-wave-2.md#phase-10-scale-and-operations-the-original-phase-6).

## Checks

```bash
pnpm lint        # Biome, the e2e selector check and the changelog fragment check, over the repository
pnpm typecheck
pnpm test        # every Vitest project; needs the shared test stack (scripts/test-services.sh up,
                 # eval "$(scripts/test-services.sh env)") or services of your own
pnpm vitest run --project docs       # one project: docs, packages, web or server
pnpm test:ci     # what CI runs: also writes reports/junit.xml and a coverage report in reports/coverage
pnpm test:clean  # drop the current run's leftover test databases (--all-stale for older idle runs)
node scripts/check-versions.mjs      # every file that names the release version agrees (see Releasing)
pnpm audit --prod --audit-level=moderate   # accepted advisories are listed in SECURITY.md
```

Biome checks every directory unless `biome.json` excludes it; add generated output to its `files.includes` exclusions rather than leaving a new directory unchecked.

### Testing only what changed

The full local suite takes about 44 minutes on the shared test stack. While iterating on a change,
run the projects and files it touches instead:

```bash
eval "$(scripts/test-services.sh env)"    # the shared stack, once per shell
pnpm test:affected:print                  # what would run: projects, files and the reason for each
pnpm test:affected                        # run it with Vitest, one invocation per selected project
```

`scripts/test-affected.mjs` takes the changed files from `git diff --name-only <base>...HEAD`
plus staged, unstaged and untracked files, then maps them:

- the base is the nearest `origin/feat/phase-*` branch that is an ancestor of HEAD (the phase
  branch a task branch was cut from), or `origin/main` when none qualifies; `--print` shows which
  base it chose and why. `AM_AFFECTED_BASE` overrides the default and `--base <ref>` overrides both;

- a changed test file runs that file in its own Vitest project; the docs project's file list is read
  from `vitest.config.mts`, so a new docs test is routed without editing the script;
- a change confined to `apps/web/src/features/<name>/` runs the web tests whose import graph reaches
  it; any other admin-UI change runs the whole web project;
- `docs/**` and `*.md` run the docs project;
- any change to `packages/*/src/**`, `apps/server/src/**`, an `apps/server/test/**` helper or
  `apps/server/test/e2e/**` runs the whole `server`, `docs` and `packages` projects, plus `web` when
  web tests or the web runtime depend on that package. The reason is printed: a static import scan
  cannot see the harness path, subprocesses or the CLI bundle, so the script does not pretend to be
  precise there. `apps/server/test/e2e/**` also suggests `scripts/e2e-docker.sh smoke`.

Only test-file changes and web feature changes are fine-grained. Everything else that looks like
source runs whole projects, which is slower than a graph walk but cannot miss a test that reaches
the code through the harness, a subprocess or the CLI.

`--base <ref>` changes the comparison base, `--files a b …` maps an explicit list, `--print` (or
`--json`) only prints the plan, and arguments after `--` go to Vitest. A migration, a package
manifest, `pnpm-lock.yaml`, `vitest.config.mts`, `test-support/**`, `.github/**` or any path the
script cannot classify runs the full suite, and the output says why.

This is the quick loop, not the merge gate. The phase PR and the release still run the full suite
in CI (`pnpm test:ci`, the `test` job in `.github/workflows/ci.yml`), as does `pnpm test` locally.


### The shared test stack

One stack per machine, shared by every checkout and delegate: the services are stateless between
runs apart from the named volumes, and a checkout's tests only need their own namespace inside
them. CI keeps its own service containers and does not use this stack.

```bash
scripts/preflight.sh                    # disk, pinned images, ports, node/docker/pnpm
scripts/test-services.sh up             # Postgres, ClickHouse, Valkey, NATS and OpenBao; waits for health
eval "$(scripts/test-services.sh env)"  # TEST_DATABASE_URL, CLICKHOUSE_URL, VALKEY_URL, NATS_URL, OPENBAO_TEST_*
pnpm test
scripts/test-services.sh down           # keep the volumes
scripts/test-services.sh reset          # drop the volumes
scripts/docker-clean.sh --yes           # remove only resources labelled am-test=1
```

The defaults are the host's long-lived test ports (25432, 28123, 26379, 24222, 28200), bound to
`127.0.0.1`. The stack carries a dev OpenBao whose root token is `root` and a writable Postgres
(`am:am`), so it is not published on the LAN by default: `scripts/test-services.sh` prints the bind
address it used and warns loudly when `AM_TEST_BIND_IP` is `0.0.0.0`. Change the ports in `.env.test`
(see `.env.test.example`) or with the `AM_TEST_PG_PORT`, `AM_TEST_CH_PORT`, `AM_TEST_VALKEY_PORT`,
`AM_TEST_NATS_PORT` and `AM_TEST_OPENBAO_PORT` variables. A process that runs inside a container
cannot reach the host's loopback, so the script then binds the Docker bridge's host address
(`172.17.0.1`) instead; on a host the same is available explicitly with
`AM_TEST_BIND_IP=172.17.0.1 scripts/test-services.sh up`, and a LAN peer would need
`AM_TEST_BIND_IP=<lan-ip>` (a deliberate, warned-about choice). `scripts/test-services.sh env` prints
`localhost` on a normal host and the bind address inside a container; set `AM_TEST_HOST` to override
that. The optional `mail` (Mailpit) and `obs` (Grafana otel-lgtm) profiles are off unless named:
`scripts/test-services.sh up mail obs`.

The scripts target **Linux (Unraid included)**. macOS needs bash 5 and GNU coreutils from
Homebrew (`brew install bash coreutils`; run the scripts with `$HOMEBREW_PREFIX/bin/bash` and keep
`gtimeout` on `PATH`). The scripts fail fast with that message rather than half-running.

`scripts/docker-clean.sh` selects containers, volumes and networks by the `am-test=1` label only,
never by name: another checkout's `amtest-*` or `am-patch-test-*` containers and a release
install are left alone. It is a dry run until `--yes`.

#### Runs, names and workers

The `server` project runs its files in parallel, four at a time (`TEST_WORKERS` sets the worker
count; 1 runs them one by one). Each file gets its own Postgres and ClickHouse database, NATS
namespace and Valkey prefix, and `apps/server/test/setup.ts` migrates one template database first
so every file starts from a copy of it. Ports come from `testPort()` in
`apps/server/test/harness.ts`, which gives each worker its own block; `TEST_PORT_OFFSET` moves
every block and the seeded e2e server's default port, so a second checkout can run at the same
time even against another stack.

`AM_TEST_RUN` namespaces a whole run: every database, ClickHouse database, NATS namespace and
Valkey prefix is written `am_<run>_...`, so two checkouts (or two delegates) can use one stack
without dropping each other's data. `vitest.config.mts` derives it once per `pnpm test` from the
checkout path and the Vitest process, and every project and worker inherits it. CI leaves it empty
so its fixed service containers keep the names they always had. Set it yourself for a named run
(lower-case letters and digits; other characters are removed, and ids longer than 16 characters
are hashed to 10 hex characters).

`scopedDbName()` in `packages/db/test/run.ts` is the one name builder the harness, the e2e server
and the cleanup use; it refuses a name over PostgreSQL's 63-byte identifier limit. A shell wrapper
can print the exact database name its `AM_TEST_RUN` produces, and must use that answer rather than
compose one itself:

```bash
AM_TEST_RUN=example node --import tsx packages/db/test/print-db.ts am_e2e_20260101_120000_123
# am_example_e2e_20260101_120000_123
```

Global teardown drops only `am_<run>_*` databases and ClickHouse databases, and deletes NATS
streams under the same prefix (so package-test namespaces that no database name reveals go too);
`AM_TEST_KEEP_DB=1` keeps them after a failure for inspection. `pnpm test:clean` cleans only
`AM_TEST_RUN`'s own namespace. `pnpm test:clean -- --all-stale` may also remove other runs, but only
when `pg_stat_activity` shows no connection and PostgreSQL reports the database older than
`AM_TEST_CLEAN_STALE_MINUTES` (default 60); it prints every database it skips and why.

### Determinism rules

The suite is a release gate, so a test must produce the same result on any machine, in any worker order:

- **Time:** every Vitest project runs with `TZ=UTC`, pinned at the top of `vitest.config.mts` and in `test.env`. Do not depend on the host time zone; a test that exercises a workspace time zone passes it explicitly.
- **Randomness:** use `seededRandom()` from `test-support/index.ts` for fixture data, not `Math.random()`. It reads `AM_TEST_SEED` (default `0x5eed1234`) and prints the seed on failure when the default was used. A failing run is reproducible with `AM_TEST_SEED=<seed> pnpm vitest run`.
- **Triggers:** use `uniqueEvent('Wait Start')` for an event name that only one test owns, and `uniqueJourney(content)` (with `triggerEventOf(content)` when the test must send the trigger) so a published journey cannot be entered by another test's person.
- **Order:** when the query behind a result has no defined order, compare with `expectUnordered(actual, expected)` instead of `toEqual` or `.sort()`. Do not add `ORDER BY` to product code just to stabilise a test.
- **CLI tests:** the server project's global setup bundles the CLI once and exports `AM_TEST_CLI`; tests spawn that artifact. Never add `--import tsx` to a per-call `execFile`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, the version check, the audit and the documentation tests in a `static` job, the suite in `test`, and the browser, image and chart checks in `e2e`, `docker-smoke` and `helm`. The `e2e` job runs the functional specs and the axe checks; `visual` compares the committed baselines and uploads the diff images on failure, on pull requests that touch `apps/web` or `e2e`; `screenshots` captures the full matrix as an artifact when a manual run asks for it. Pull requests that only change Markdown, `docs/` or `.claude/` skip the slow jobs. The release workflow calls the same file for the tagged commit.

### Migrations

Migrations are forward-only SQL files in `packages/db/migrations`, named `NNNN_name.sql` and applied
in filename order, each in its own transaction under an advisory lock. The runner creates the
`am_app` role first (the migrations' `GRANT`s name it) and records each file's checksum in
`schema_migrations`; editing an applied file stops the process with "was changed after it was
applied", so add a new file instead. The server migrates on start (`SKIP_MIGRATIONS=true` for a role
that must not) and `cli migrate` runs the same code. When a release ships a new head, add it to
`MIGRATION_RELEASES` in [`packages/db/src/migrate.ts`](../packages/db/src/migrate.ts): backups and
`am doctor` use that map to name the release a database last ran. Only heads are listed; a release
whose migrations share a head with another is a range.

#### Non-transactional migrations

A migration whose first line is `-- am:no-transaction` runs outside `BEGIN`/`COMMIT`, one statement
at a time, so `CREATE INDEX CONCURRENTLY` and other statements Postgres refuses inside a transaction
block work. The advisory lock, checksum check and `schema_migrations` record are unchanged, but the
file is recorded only after every statement succeeds. A failure leaves the earlier statements
committed, so write these files to survive a retry: every statement idempotent (`IF NOT EXISTS`,
`ON CONFLICT DO NOTHING`, or an update that is harmless twice), and no statement that depends on
its own previous effect being absent.

Before a `CREATE INDEX CONCURRENTLY`, the runner drops that index if Postgres marked it `INVALID`
(what an interrupted build leaves behind); it repeats the cleanup after a failure, so the next start
does not stay stuck on `IF NOT EXISTS`. `am doctor` reports an invalid index that is still present.
Do not put a statement that needs a transaction in such a file: it commits on its own.

Long data changes do not belong in a migration at all. The 0.10.1 `messages.sent_at` backfill is a
scheduler job (`runSentAtBackfill` / `backfillSentAtOnce` in
[`packages/db/src/backfill.ts`](../packages/db/src/backfill.ts)) that fills completed rows in short
batches after start. It stops when no row is left or a batch fails: there is no continuous retry, so
a failed pass runs again on the next start. `am doctor` shows how many rows are left.
The delivery caps count a NULL `sent_at` from `updated_at` until the job reaches the row, so
correctness does not depend on the backfill finishing first.

### Releasing

A release is one pass plus one review. Start from a clean `main`:

1. `node scripts/release/prepare.mjs <version> --previous <previous>` — bumps every version surface `scripts/check-versions.mjs` lists (the root, `apps/server`, `apps/web`, `packages/sdk-js` and `packages/edge-worker` package files, the chart's `version` and `appVersion`, `AM_VERSION` in `.env.example` and its default in `docker-compose.yml` and the README, the README's "current release is the **X.Y** line" sentence, and the release status lines of `docs/architecture/README.md`, `overview.md` and `roadmap.md`), folds `changelog.d/` fragments and the `## [Unreleased]` section into `## [<version>] - <date>`, generates the `### Upgrading from <previous>` block from the migrations and `.env.example` changes since that tag, records new variables in `ENV_SINCE`, and runs `node scripts/check-versions.mjs`. It refuses to run in a shallow clone (run `git fetch --unshallow --tags`), because the tag range would be silently truncated.
2. Update the "Now" state of `docs/status/current.md`: it must name `<version>` as released (`**<version>** … is released`) and the previous release as the last one. This is not prose prepare.mjs can generate, so it is a check instead: `prepare.mjs <version> --check` and `check-notes.mjs` both fail while the handoff still says this release is in progress, and the release workflow runs `check-notes.mjs` before publishing (#785).
3. Review the generated `### Upgrading from <previous>` block in `CHANGELOG.md`. Replace the `TODO` under **Breaking changes** with the user-visible changes or `none`. `node scripts/release/prepare.mjs <version> --check` fails while a `TODO` remains or a field is missing or empty. CI runs `node scripts/release/check-notes.mjs` on any pull request that changes `CHANGELOG.md`, and the release workflow runs it again before publishing, so an incomplete block cannot ship.
4. Commit the release changes and open the release pull request.
5. Merge it to `main`.
6. Release that commit through the release workflow: run **Actions → Release → Run workflow** from `main` with the version, or push a `v<version>` tag. `.github/workflows/release.yml` runs the same CI on the commit, builds and smoke-tests the amd64 image, pushes linux/amd64 and linux/arm64 with build-provenance attestations, packages the Helm chart and the Compose bundle with `SHA256SUMS`, and creates the GitHub release from the `## [<version>]` section. 0.x releases are marked as pre-releases. Releases of one line (`major.minor`) are serialised, and the floating `:<major>.<minor>` image tag is pushed only when this version is the newest in its line, so an older patch re-run can never move it backwards (#773).
7. `scripts/release/verify.sh <version>` — downloads the GitHub release into a fresh temporary directory, runs `sha256sum -c SHA256SUMS`, verifies the attestation of every asset and of `oci://ghcr.io/<owner>/agentic-marketing:<version>`, and checks that the image manifest has `linux/amd64` and `linux/arm64`. It prints PASS/FAIL per check and exits non-zero on any failure.
8. `scripts/release/close-issues.mjs <version> --yes` — collects the issues named by the release's merged pull requests' `Closes #` lines and by the fragment `issues:` marker, comments with the release link and closes the ones still open. Without `--yes` it is a dry run. It refuses a shallow clone too, so a depth-1 CI checkout cannot silently narrow the release range (#772).

A new migration head also goes into `MIGRATION_RELEASES` (see [Migrations](#migrations)); `prepare.mjs` lists the migration files it finds but cannot know which one is the new head. Before tagging, check that private vulnerability reporting is still enabled (Settings → Security), since `SECURITY.md` points reporters to it.

Contributors and delegates add a fragment under `changelog.d/` instead of editing `CHANGELOG.md`; see [`changelog.d/README.md`](../changelog.d/README.md).

### Services without Docker

The tests need the four services on localhost, not Docker: native packages or the projects' own binaries work. Two ClickHouse settings matter outside the official image:

- start it with `--custom_settings_prefixes=SQL_` (the image's default config has it): the row-policy tests set `SQL_workspace`, and without the prefix ClickHouse rejects the setting;
- any server time zone works. Event times are stored and queried as UTC (query parameters are typed `DateTime64(3, 'UTC')`; `packages/events/test/utc-params.test.ts` enforces it).

For example, ClickHouse's single binary: `clickhouse server -- --path=./data/ch/ --http_port=8123 --tcp_port=9000 --listen_host=127.0.0.1 --custom_settings_prefixes=SQL_`, Postgres 16 (the default `max_connections=100` covers four parallel test files), `nats-server -js` and `valkey-server --save "" --appendonly no`.

## Conventions

- Phases are built by parallel tasks on a phase branch, one draft PR per task; see [the phase workflow](process/delegates.md) for the branch model, the shared-file rules and the delegate brief template.
- Dependencies are pinned to exact versions that have been published for at least two weeks (`.npmrc` `save-exact`). Better Auth packages are pinned together via `pnpm.overrides`.
- Migrations are forward-only SQL files in `packages/db/migrations`; never edit an applied one (the runner refuses).
- Every tenant table has `workspace_id` and row-level security. Command handlers use the transaction they are given and do not filter by workspace manually.
- Errors users or agents can act on are `AppError`s with a message that says what to do next.
