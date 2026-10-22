# Roadmap, wave 2 (replanned 2026-10-22)

Wave 1 (Phases −1 to 5 and the MartechSignal pilot) built the platform end to end: data platform, e-mail, segments, journeys, web personalization, AI runtime, integrations, and the newsletter features for a content site. Wave 2 takes in:
- every limitation recorded along the way;
- the original Phase 6 (breadth and scale);
- better sending than SMTP, plus SMS;
- performance marketing with Google, Meta and Microsoft ads.

It replaces the old Phase 6 in [roadmap.md](roadmap.md).

## How it is prioritised

Each item is scored on four questions, in this order:
1. **Does it unblock real use now?** The MartechSignal pilot and the owner's own marketing come first: a platform nobody runs teaches nothing.
2. **Is it a prerequisite?** E.g. consent signals and OAuth come before ad platforms; frequency caps come before sending more.
3. **Value per effort** for a team of one: high value and small effort first.
4. **Risk if postponed**: compliance, deliverability and data loss outrank convenience.

Items that are big and only matter at a scale nobody runs yet (10M profiles, SSO for large organisations) move later, on purpose.

## The phases at a glance

| Phase | Theme | Main contents | Depends on | Size* | "Done" means |
|---|---|---|---|---|---|
| **6** | **Pilot live and hardening** | MartechSignal in production; fixes and gaps found while running it | – | M | Four weekly issues sent from the platform, Kit closed |
| **7** | **Delivery: beyond SMTP, and SMS** | Cloudflare adapter (transactional), deliverability guardrails, frequency caps and quiet hours, SMS channel | 6 | M–L | Rates monitored and enforced; SMS sent and STOP honoured end to end |
| **8** | **Consent everywhere** (prerequisite for ads and on-site tracking) | Consent banner, Consent Mode v2 signals, ad purposes, click-id capture, OAuth2 token store | 6 | M | A site collects consent with the banner; click ids and ad consent land on profiles; OAuth connections refresh |
| **9** | **Performance marketing** | Google (Data Manager API), Meta (Conversions API and custom audiences), Microsoft (offline conversions, Customer Match), spend import, ROAS | 8 | L | Conversions and audiences sync to Google and Meta with consent; spend and ROAS per campaign |
| **10** | **Scale and operations** (the original Phase 6 core) | Helm, load testing to 10M profiles, SQL/ClickHouse segment evaluation, journey version migration, warehouse export, config-as-code, retention jobs | 6 | L | Reference deployment documented at 10M profiles |
| **11** | **Enterprise and ecosystem** | SSO and SCIM, Salesforce, web and mobile push, more ad and CRM connectors, experience editor, AI improvements | 8, 10 | L | Per item |
| Later | | Probabilistic identity, recommendations, autonomous goal-driven agents (scope C), SaaS multi-tenancy and billing, an Activepieces pieces runner | | | |

\*Size in working sessions of the current kind: S ≈ 1, M ≈ 2–3, L ≈ 4+.

Phases 7 and 8 have no dependency on each other and can swap if paid acquisition becomes urgent. Phase 9 cannot start before 8.

## Phase 6: pilot live and hardening

Goal: MartechSignal runs on the platform, and everything it needs that is still missing gets built.

- **Run the pilot** ([plan](../pilots/martechsignal.md)): the tunnel hostname, the form and double opt-in, the Kit import, the weekly broadcast, the welcome journey.
- **Send through SES or Postmark instead of the SMTP relay.** The adapters exist, with bounce and complaint events.
- **E-mail clicks as profile events** (`Email Link Clicked`, with message, broadcast or journey, and URL), so segments ("engaged readers") and journey branches can use them.
- **Retention and cleanup jobs:** unconfirmed double opt-in profiles after N days; configurable retention for messages, events, AI calls and deliveries; erasure-safe.
- **UTM auto-tagging** option on broadcasts and journeys (`utm_source=newsletter&utm_campaign=<broadcast>`), for Umami.
- **Broadcast quality of life:** a test send to yourself; an A/B subject test on a sample, with the winner sent to the rest; a send-time window.
- **Screens for forms and broadcasts** (they are artifacts today, with the generic editor only); a **members screen**.
- **E-mail delivery events in webhook subscriptions** (Phase 5 limit).
- **Tracking-plan warnings stored for a report** (Phase 1 limit).
- **The Docker image built and smoke-tested in CI** (never run so far: a real risk for a production pilot).

Done when the pilot's "done" criteria hold for four consecutive Fridays.

## Phase 7: delivery beyond SMTP, and SMS

Design: [email-and-sms-delivery.md](email-and-sms-delivery.md).
- **Cloudflare Email Service adapter** (beta) for the transactional stream; SES or Postmark stay on the marketing stream until Cloudflare documents bulk sending and bounce and complaint events.
- **Deliverability guardrails:** a domain check for SPF, DKIM and DMARC; complaint and bounce rate monitoring with automatic pause of marketing sends; per-provider rate limits and warm-up.
- **Frequency caps and quiet hours** in the gateway (Phase 2 limit).
- **SMS channel:**
  - GatewayAPI and Twilio adapters with delivery reports;
  - `marketing_sms` and `service_sms` purposes;
  - SMS double opt-in, and STOP/HELP keywords on inbound;
  - an `sms_template` artifact, a journey node and broadcasts;
  - budgets.
- **Bounce mailbox (VERP)** for SMTP-only installs: optional, last.

## Phase 8: consent everywhere

The prerequisite for paid media and for on-site tracking (MartechSignal phase B):
- **Consent banner component** in the SDK: small and accessible, CSP-safe (no inline script), texts from the `purposes` artifact, a re-open link, and proof stored as SDK consent events. It also sends **Google Consent Mode v2** signals (`ad_storage`, `ad_user_data`, `ad_personalization`, `analytics_storage`) for sites that run Google tags.
- **Ad purposes in the defaults:** `ad_measurement` and `ad_targeting`, mapped to each platform's consent fields.
- **Click-id capture:** `gclid`, `gbraid`, `wbraid`, `fbclid` → `fbc`, `fbp`, `msclkid`. The SDK captures them (with consent) and forms take hidden fields; they are stored as identifiers.
- **OAuth2 token store and refresh worker** for connectors (Phase 5 limit). Google, Meta and Microsoft all need it, and so does Salesforce later.
- **Shared rate limits in Valkey**, across workers (Phase 5 limit), before many workers call ad APIs.
- **MartechSignal phase B (optional):** the banner, the SDK from `dist/am.min.js`, and interest segments from reading behaviour.

## Phase 9: performance marketing

Design: [performance-marketing.md](performance-marketing.md). Built in this order:
1. **Meta Conversions API:** `Lead` and `Purchase` from mapped events with `event_id` de-duplication, hashed identifiers and `fbc`/`fbp`. A system-user token keeps the setup simple.
2. **Google Data Manager API conversions:** offline conversions with click ids and enhanced conversions for leads (hashed e-mail and phone), with consent fields. The Google Ads API path for these closed on 15 June 2026.
3. **Audience sync:** segments → Google Customer Match (Data Manager `audienceMembers:ingest`) and Meta custom audiences. Add and remove deltas, nightly reconcile, consent-gated, with the flagged-audience error handled.
4. **Spend import and ROAS:** daily cost and clicks per campaign (Google Ads API reports, Meta Insights) into ClickHouse; first-party attribution next to platform-reported numbers; MCP tools `ads.performance` and `ads.audiences`.
5. **Microsoft Advertising:** offline conversions with `msclkid` (Bulk API), Customer Match where eligible, reporting. The new server-side Conversions API is per-account pilot only.
6. **Guardrails:** test modes (`validateOnly`, `test_event_code`); uploads per person in `profiles.export`; erasure removes people from synced audiences; no agent write access to budgets or bids in this wave.

## Phase 10: scale and operations (the original Phase 6)

- **Helm chart** and a documented reference deployment; KMS or OpenBao key providers (Phase 0 deferral).
- **Load testing to 10M profiles:**
  - segment evaluation as SQL and ClickHouse set operations instead of in-memory ids (Phase 2 limit);
  - ClickHouse row policies (Phase 1 limit);
  - NATS retention on encrypted volumes, with a shorter default (Phase 1 limit).
- **Journeys:**
  - migrate participants between journey versions (the original Phase 6);
  - wake waiting participants after a profile merge (Phase 2 limit).
- **Warehouse export and sync** (BigQuery, Snowflake, Postgres) and **config-as-code** export and import of artifacts (the original Phase 6).
- **Correctness:** atomic AI budget reservation (Phase 4 limit); prompt tests as jobs, not in the command transaction (Phase 4 limit); the egress guard also on e-mail provider adapters (Phase 5 limit).
- **Segment snapshots** updated right after scheduled refreshes, not at the person's next event (Phase 3 limit); a shorter experience-definition cache via invalidation (Phase 3 limit).

## Phase 11: enterprise and ecosystem

- **SSO (OIDC, SAML) and SCIM** (the original Phase 6); **MCP scope step-up** (Phase 0 deferral).
- **Connectors:**
  - Salesforce, on the OAuth store;
  - deeper Shopify (app install, customer and product sync);
  - ad platforms beyond the big three (LinkedIn, TikTok, Pinterest).
- **Push:** web push (VAPID) first, mobile (FCM, APNs) on demand (the original Phase 6).
- **Web personalization:**
  - a visual experience editor (Phase 3 limit);
  - sequential and Bayesian experiment statistics (Phase 3 limit);
  - **edge decide on Cloudflare Workers** with KV or Durable Object snapshots (Phase 3 limit, "Later" in wave 1).
- **AI:**
  - cache generated text per segment;
  - sample decisions for human review;
  - `ai.classify`;
  - stream copilot tokens and keep conversations server-side;
  - OpenAI OAuth if it becomes available (Phase 4 limits, open question 4).

## Every known limitation, and where it lands

| Limitation (where it was recorded) | Phase |
|---|---|
| Docker image never run (Phase 0) | 6 |
| No members screen (Phase 0) | 6 |
| KMS/OpenBao key providers deferred (Phase 0) | 10 |
| MCP scope step-up deferred (Phase 0) | 11 |
| JetStream keeps personal traits for its retention window (Phase 1) | 10 |
| No ClickHouse row policies (Phase 1) | 10 |
| Tracking-plan warnings not stored for a report (Phase 1) | 6 |
| No bot filtering on ingest (Phase 1) | 8 (with the consent banner and the SDK) |
| Frequency caps and quiet hours not enforced (Phase 2) | 7 |
| No bounce mailbox for pure SMTP (Phase 2) | 7 (optional; HTTP adapters preferred) |
| Segment evaluation holds ids in memory (Phase 2) | 10 |
| Merged profile does not wake waiting participants (Phase 2) | 10 |
| Experience definitions cached 30 s (Phase 3) | 10 |
| Fixed-horizon experiment statistics only (Phase 3) | 11 |
| No visual experience editor; no edge decide (Phase 3) | 11 |
| Snapshot lag after scheduled segment refresh (Phase 3) | 10 |
| No generated-text caching, decision sampling or `ai.classify` (Phase 4) | 11 |
| AI budgets can be overshot; prompt tests in the command transaction (Phase 4) | 10 |
| No OAuth for LLM providers (Phase 4) | 11 |
| Copilot streams steps, not tokens; history in the browser (Phase 4) | 11 |
| No OAuth2 connectors / token store (Phase 5) | 8 |
| E-mail delivery events not in webhook subscriptions (Phase 5) | 6 |
| Rate limits per process; egress guard not on e-mail adapters (Phase 5) | 8 and 10 |
| Unconfirmed double opt-in profiles are never cleaned up (pilot) | 6 |
| No A/B subject or send-time option for broadcasts (pilot) | 6 |
| No screens for forms and broadcasts (pilot) | 6 |
| No consent banner (pilot) | 8 |
| E-mail clicks are not profile events (pilot) | 6 |
| SMTP gives no delivery events (pilot, ADR-0011) | 6 (switch to SES or Postmark) and 7 |
| Activepieces pieces not embeddable safely (spike 5) | Later (pieces runner) |
| Legal review of legitimate-interest templates and retention defaults (open question 10) | 6 (needed before the pilot goes live) |

## Decisions needed from the owner

1. **Pilot sender:** SES (cheapest; needs an AWS account and production access) or Postmark (simplest; costs more per message). The SMTP relay stays as a fallback.
2. **SMS provider:** GatewayAPI (EU and Nordic) or Twilio (global), and the countries to send to.
3. **Ads order:** Meta first (proposed: simplest auth, CAPI and audiences in one API) or Google first. Microsoft follows either way.
4. **Agent write access to ad accounts** (budgets, bids, pausing campaigns): proposed "never in wave 2"; agents propose and people act.
