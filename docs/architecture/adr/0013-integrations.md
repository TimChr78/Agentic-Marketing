# ADR-0013: Integrations through signed webhooks, API tokens and an own connector SDK

- Status: Accepted (Phase 5)
- Date: 2026-10-22

## Context
Phase 5 connects the platform to other systems.
- The first users are automation tools (n8n in the owner's homelab, Zapier, Make, Activepieces) and shops (Shopify) more than first-party connectors.
- Outbound calls carry customer data and reach URLs typed in by workspace admins. That is the classic SSRF and data-leak surface.
- The project must stay maintainable by one person.

## Decision
1. **API tokens for machines.**
   - A token is an agent principal for the person who made it: role permissions limited to the token's scopes.
   - It is accepted as `Bearer amk_…` on REST and MCP. Only a hash is stored; it can be revoked and expire.
   - OAuth stays the path for interactive MCP clients. Tokens are for tools that cannot do OAuth flows.
2. **Outbound webhooks follow Standard Webhooks.**
   - Requests carry `webhook-id`, `webhook-timestamp` and `webhook-signature`, keyed by a `whsec_` secret, so any receiver library verifies them.
   - Endpoints subscribe to customer events after identity resolution (each event carries its profile id and non-personal traits) and receive journey webhook steps.
   - An endpoint may name a purpose; events of people without a lawful basis for it are not sent.
3. **One delivery queue** (`deliveries`) for webhooks and connector actions.
   - Workers claim due rows with a lease and call out outside any transaction.
   - Webhooks retry with backoff over about 21 hours, then go to a dead letter that can be retried by hand.
   - Journey actions retry briefly, then wake the participant with the result or error (ok/error edges, as with AI steps in ADR-0012).
4. **Egress guard.**
   - Only http(s); no credentials in URLs; no redirects; 10 s timeout; responses capped at 256 KB.
   - The resolved address is checked when the socket connects, against private, loopback, link-local, CGNAT and metadata ranges, which also defeats DNS rebinding.
   - Installs allow LAN targets explicitly with `EGRESS_ALLOWED_HOSTS`.
5. **Our own connector SDK** (`defineConnector`):
   - settings and secrets as Zod schemas (secrets sealed and write-only);
   - `inbound` (`verify` and `map` to Segment-spec events, ingested through the same policy as the gateway at `/hooks/in/<connection>/<token>`);
   - `actions` (input schema and `run` with an injected, guarded `request`);
   - a rate limit.

   Built in: a generic webhook (JSONata mapping, HMAC or Standard Webhooks verification), Shopify, Slack and an HTTP API.
6. **Automation steps:** `transform` (JSONata into `vars`), `action` and `webhook`. JSONata only sees non-personal traits and the participant context.

## Alternatives
- **Embedding Activepieces pieces:** rejected for now ([spike 5](../../../spikes/activepieces/FINDINGS.md)). The pieces bring their own HTTP clients, which bypass the egress guard, have no license metadata on npm, and expose an internal runtime contract. They remain possible later in a separate process.
- **Embedding n8n:** excluded by its Sustainable Use License; it orchestrates from the outside.
- **Nango for OAuth:** not permissively licensed. OAuth2 connectors will use our own sealed token store when one is needed.
- **Per-endpoint queues or a separate job system:** one table with leases matches the journey and AI-step queues, and needs no new infrastructure.

## Consequences
- n8n and similar tools can trigger on our events, feed events in, and drive every command, through the same validation, permissions and audit as people and agents.
- New connectors are small TypeScript files, but each one is ours to maintain. Breadth comes from webhooks and the generic HTTP connector before first-party code.
- Webhook payloads exclude personal traits. A receiver that needs an e-mail address has to fetch it with a token that has `profiles:pii`, which is audited.
- No OAuth2 connectors yet; Salesforce will need the token store and refresh worker.
