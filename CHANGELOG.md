# Changelog

All notable changes to Agentic Marketing. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, minor versions may change the commands API, the configuration and the artifact formats, and the notes say how to move.

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
