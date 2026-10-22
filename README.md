# Agentic Marketing

An open-source, self-hostable marketing platform built **agent-first**: every capability is a command that works the same over REST, MCP (for AI agents) and the web UI, under the same permissions, approvals and audit log. Underneath is an event-based customer data platform with GDPR-grade consent handling. You bring your own LLM keys.

It runs as one Docker image (a TypeScript modular monolith) next to Postgres, ClickHouse, NATS and Valkey, and is sized for a team of one up to a few million profiles.

## What it does

- **Collect events:** Segment-compatible ingest (`/v1/batch`), a browser SDK, per-source consent rules, a tracking plan, bot filtering.
- **Consent banner:** in the SDK, CSP-safe, with texts from your purposes and Google Consent Mode v2 signals. Ad click ids (`gclid`, `fbclid`, `msclkid`…) are kept only with `ad_measurement` consent.
- **Know people:** identity resolution and merges, profiles with traits and events, a consent ledger per purpose, export and erasure (DSR).
- **Segments:** conditions on traits, events, consent and other segments, recomputed continuously, with enter and exit events. Whole-segment refreshes run as SQL in Postgres and ClickHouse, load-tested to a million profiles.
- **E-mail:**
  - MJML and Liquid templates with preview, test sends and UTM tagging;
  - a send gateway that checks lawful basis, consent, objections and suppressions;
  - providers SES, Postmark, Brevo, Cloudflare Email Service or SMTP, with delivery, bounce, complaint and click events;
  - a domain check for SPF, DKIM and DMARC;
  - one-click unsubscribe (RFC 8058).

  What happens to an e-mail becomes a customer event (`Email Link Clicked`…), so segments, journeys and webhooks can use it.
- **SMS:** Twilio, with consent per purpose, STOP/START/HELP replies, delivery reports, a segment and cost preview, and a monthly budget. SMS works in journeys and broadcasts.
- **Delivery policy:** for marketing messages on every channel:
  - frequency caps;
  - quiet hours in each person's time zone;
  - an automatic pause when bounce or complaint rates pass the limits.
- **Newsletter:** signup forms with double opt-in (works without JavaScript, optional Cloudflare Turnstile), subscriber import with consent proof (from Kit, Mailchimp…), broadcasts to a segment.
- **Journeys:** a visual builder and an engine with waits, branches, e-mail, SMS, webhooks, connector actions and AI steps (decide, generate) with fallbacks; people can be moved onto a new version.
- **Web personalization:** experiences and A/B tests served by a decision API, with an anti-flicker snippet and consent-aware targeting.
- **AI:** your own providers (Anthropic, OpenAI, Ollama…), metering and budgets that hold under concurrency, prompt artifacts with test runs, redaction, a decision log with sampled human reviews, text classification, generated text cached per segment, and an in-app copilot over MCP that streams its answers and keeps conversations.
- **Performance marketing:**
  - conversions to Meta (Conversions API), Google Ads (Data Manager API) and Microsoft Advertising, from a conversion map, for people who allowed `ad_measurement`;
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
  - single sign-on (OIDC, SAML) and SCIM provisioning;
  - audit log;
  - encrypted secrets with key rotation, the key in the environment, OpenBao/Vault or AWS KMS;
  - Postgres row-level security and ClickHouse row policies per workspace;
  - retention jobs.

## Quick start (Docker)

```bash
cp .env.example .env        # fill in the secrets: openssl rand -base64 32
docker compose up -d --build
docker compose exec app pnpm --filter @agentic-marketing/server cli bootstrap \
  --email you@example.com --password '…' --workspace 'My site'
```

Open http://localhost:3000, sign in, and add an e-mail provider. To let an AI agent work in the workspace, connect an MCP client (Claude, an IDE…) to `http://localhost:3000/mcp`: it registers itself, and you choose its permissions on the consent page.

Running it behind a proxy or a Cloudflare Tunnel: set `PUBLIC_URL`, `PUBLIC_LINKS_URL` and `CLIENT_IP_HEADER` (see [`.env.example`](.env.example)).

On Kubernetes: the Helm chart in [`deploy/helm`](deploy/helm/agentic-marketing) runs each role as its own Deployment; see the [reference deployment](docs/deployment/kubernetes.md).

## Documentation

- [Development](docs/development.md): layout, running locally, tests, key rotation.
- [Kubernetes reference deployment](docs/deployment/kubernetes.md): Helm, OpenBao or AWS KMS keys, sizing.
- [Single sign-on, SCIM and agent permissions](docs/identity.md).
- [Architecture](docs/architecture/README.md) and its [ADRs](docs/architecture/adr/).
- [Integrations](docs/integrations.md): webhooks, connectors, n8n, config as code, warehouse export.
- [Pilot: MartechSignal](docs/pilots/martechsignal.md): replacing Kit on a static Cloudflare Pages site.
- Agent skills in [`.claude/skills/`](.claude/skills/):
  - `agentic-marketing-implement`: rolling the stack out on a website;
  - `agentic-marketing-mcp`: operating a workspace over MCP.

## Status and roadmap

Wave 1 (Phases −1 to 5) is complete: foundations, data platform, e-mail, segments, journeys, personalization, AI and integrations.

[Wave 2](docs/architecture/roadmap-wave-2.md):

| Phase | Theme | State |
|---|---|---|
| 6 | Pilot live and hardening | The code items are done: e-mail events on profiles, retention, UTM tagging, test sends, Newsletter screen, Docker smoke test. The MartechSignal run is next. |
| 7 | Delivery beyond SMTP, and SMS | Done: Cloudflare Email Service adapter, delivery policy (caps, quiet hours, auto-pause), deliverability health and domain check, Twilio SMS. Later: GatewayAPI, SMS double opt-in, provider warm-up |
| 8 | Consent everywhere | Done: consent banner with Consent Mode v2, ad purposes, click-id capture, OAuth 2.0 connections, shared rate limits, bot filtering |
| 9 | Performance marketing | Done: conversions (Meta, Google, Microsoft), audience sync (Meta, Google), spend and ROAS. Later: Microsoft reporting and audiences, more platforms |
| 10 | Scale and operations | Done: correctness (AI budget reservations, prompt test jobs, merge-safe journeys, journey version migration, instant experience updates), scale (segments evaluated in SQL, ClickHouse row policies, a load test to 1M profiles), operations (Helm chart, OpenBao and AWS KMS keys, warehouse export, config as code) |
| 11 | Enterprise and ecosystem | Part a done (single sign-on with OIDC and SAML, SCIM provisioning, MCP scope step-up). Part b done (AI: classify, text per segment, review samples, a streaming copilot with stored conversations). Next: experiment statistics and edge decide, push, more connectors |

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # tests need Postgres, ClickHouse, NATS and Valkey
scripts/smoke.sh                           # the Docker image end to end
pnpm --filter @agentic-marketing/server cli loadtest --profiles 1000000   # segment refreshes at scale
pnpm dev:web                               # the UI (a mocked demo without the API)
```

See [docs/development.md](docs/development.md) for details.
