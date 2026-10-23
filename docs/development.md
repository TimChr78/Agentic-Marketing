# Development

## Layout

```
packages/
  core/        ids (UUIDv7, prefixed), AppError, canonical JSON hashing
  db/          SQL migrations, migration runner, Drizzle schema, pools (admin + RLS app role)
  commands/    command registry: defineCommand, permissions/roles, executor (validate → authorize → idempotency → audit)
  artifacts/   versioned artifacts (note, journey), approvals, diffs, workspace + audit commands
  secrets/     envelope encryption (KEK → per-workspace data keys), write-only secret commands
  auth/        Better Auth (people) + OAuth 2.1 for MCP clients, principal resolution
  telemetry/   pino logger, optional OpenTelemetry tracing (OTLP)
  client/      typed REST client inferred from the command registry
  edge-worker/ the decision API as a Cloudflare Worker, reading Workers KV (docs/deployment/edge.md)
apps/
  server/      Hono app: REST (/v1/<command>, /openapi.json), MCP (/mcp), sign-in/consent, health; CLI
  web/         React UI: live workspace against the real API (production build in the image at /) + Phase −1 demo (mocked, dev)
spikes/        throw-away prototypes with their FINDINGS.md (not part of CI or the image)
```

Adding a capability = one `defineCommand(...)` in a package + adding it to `apps/server/src/registry.ts`. The REST route, OpenAPI entry, MCP tool and typed client call follow automatically.

## Run locally

Requirements: Node 22+, pnpm 10, PostgreSQL 16, ClickHouse (26.8 LTS), NATS with JetStream (`nats-server -js`) and Valkey (or Redis), local or Docker. `CLICKHOUSE_URL`, `NATS_URL` and `VALKEY_URL` default to localhost.

```bash
pnpm install
cp .env.example .env          # fill AUTH_SECRET and MASTER_KEY (openssl rand -base64 32), point DATABASE_URL at Postgres
pnpm --silent --filter @agentic-marketing/server cli bootstrap --email you@example.com --workspace 'My shop'
pnpm dev                       # API on http://localhost:3000 (migrates on start)
pnpm dev:web                   # UI on http://localhost:5173 → "Live workspace (API)", demo screens included
```

For development the demo still starts; the production build is the live workspace only:

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

`CLIENT_IP_HEADER` is an ordered, comma-separated list; the first valid address of the first header present is used. With `TRUSTED_PROXY_CIDRS` set, headers are ignored unless the socket address is in one of those ranges (bare IPs and CIDR ranges, IPv4 or IPv6), so a client cannot spoof its rate-limit bucket. Admin LAN traffic has no forwarding header and falls back to the socket address. Empty `TRUSTED_PROXY_CIDRS` trusts the headers from any source, which preserves the previous behavior; set it to your tunnel/proxy and loopback ranges in production.

### Docker Compose

```bash
cp .env.example .env   # fill in the secrets
docker compose up --build
docker compose exec app am bootstrap --email … --workspace …
```

`am` runs the server CLI without pnpm's banner. The command prompts for the password without echo; for scripts use `docker compose exec -e AM_BOOTSTRAP_PASSWORD app am bootstrap …` (or pipe one line with `docker compose exec -T`). `am reset-password --email …` (with `AM_RESET_PASSWORD`) sets a new password. `--password` is deprecated.

`scripts/smoke.sh` (also run in CI) does this end to end with a throw-away compose project: start, bootstrap, sign in, publish a signup form, and check its confirmation e-mail is sent.

### Collecting events

Add a source in the UI ("People & data") or with `sources.create`. Browser sources get a public write key and only accept their allowed origins; by default they keep an event only when the visitor allowed the `analytics` purpose. On a site, use `@agentic-marketing/sdk-js` (`packages/sdk-js`), or any Segment-compatible library pointed at this server (`/v1/batch`, write key as the Basic auth user name). Events show up on the person's profile within a couple of seconds; `ROLE` decides which processes run the `api`, `ingest` and `worker` parts (all by default).

### Personalizing the website

Mark elements with `data-am-placement="home_hero"`, put `antiFlickerSnippet()` from `@agentic-marketing/sdk-js` in the page head, and call `analytics.personalize()` after loading the SDK. Create a web experience for the placement (UI "Web experiences" or `artifacts.create` with type `experience`); published experiences are served by `POST /v1/decide` within 30 seconds. Visitors who have not allowed `web_personalization` only get page-based targeting (page, referrer, UTM, device).

### AI providers and the copilot

Add a provider under Live workspace → AI with your own key. Base URLs:
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

`.claude/skills/agentic-marketing-implement` (rolling the stack out on a website, with Cloudflare specifics) and `.claude/skills/agentic-marketing-mcp` (operating a workspace over MCP) load automatically in Claude Code sessions in this repo. To use them from a website's repo, copy both folders into that repo's `.claude/skills/`. The worked example is [pilots/martechsignal.md](pilots/martechsignal.md).

### Members

Owners and admins invite people with `members.invite` (UI, REST or the typed client; agents cannot). The response holds a one-time link, `<PUBLIC_URL>/invite#<token>`, valid for 7 days. Send it to the person; they sign in or create an account with the invited e-mail address and join with the invited role. Only owners can make or change owners, and the last owner can be neither demoted nor removed.

### Rotating the master key

To keep the key-encryption key in OpenBao/Vault Transit or AWS KMS instead of `MASTER_KEY`, see [the Kubernetes guide](deployment/kubernetes.md#keys-master_key-openbao-or-aws-kms); `cli rotate-keys` moves existing data keys over.

Secrets are encrypted with per-workspace data keys, which are wrapped by `MASTER_KEY`. To rotate it:

1. Generate a new key (`openssl rand -base64 32`), set it as `MASTER_KEY`, and put the old one in `MASTER_KEY_PREVIOUS`. Restart; everything keeps working, and new data keys use the new master key.
2. Run `pnpm --filter @agentic-marketing/server cli rotate-keys` to re-wrap every existing data key with the new master key.
3. Remove `MASTER_KEY_PREVIOUS` and restart.

### ClickHouse row policies

Every ClickHouse table with a `workspace_id` has a row policy (`am_workspace`): a query sees only the rows of the workspace in its `SQL_workspace` setting, and none without it. The event store sets it on every query, so the policy backs up the workspace filters in code. Creating the policies needs a ClickHouse user with access management (`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` in the official image, as in `docker-compose.yml`) and the `SQL_` custom-settings prefix (in the image's default config). `CLICKHOUSE_ROW_POLICIES=required` (compose, CI) refuses to start without them, `auto` (default) applies them when it can, `off` removes them. To look at data by hand: `SELECT … SETTINGS SQL_workspace = '<workspace id>'`.

### Load test

`pnpm --filter @agentic-marketing/server cli loadtest --profiles 1000000` seeds a throwaway workspace with synthetic people (traits, a user id, consent) and their events straight into Postgres and ClickHouse, refreshes five segments (trait, event count in a window, "never did", consent, and a combination with `not`) twice, checks every size against what the data implies, prints the timings and removes the workspace (`--keep` leaves it). Results are in [the reference deployment notes](architecture/roadmap-wave-2.md#phase-10-scale-and-operations-the-original-phase-6).

## Checks

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # unit + integration; needs Postgres (TEST_DATABASE_URL, default postgres://am:am@localhost:5432/am_test),
                 # ClickHouse (CLICKHOUSE_URL) and NATS (NATS_URL); test databases and streams are recreated per run
```

CI (`.github/workflows/ci.yml`) runs the same three against a Postgres service container.

## Conventions

- Dependencies are pinned to exact versions that have been published for at least two weeks (`.npmrc` `save-exact`). Better Auth packages are pinned together via `pnpm.overrides`.
- Migrations are forward-only SQL files in `packages/db/migrations`; never edit an applied one (the runner refuses).
- Every tenant table has `workspace_id` and row-level security. Command handlers use the transaction they are given and do not filter by workspace manually.
- Errors users or agents can act on are `AppError`s with a message that says what to do next.
