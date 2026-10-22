# Spike 5 — Can Activepieces pieces serve as our connector actions?

**Question:** Activepieces publishes its integrations ("pieces") on npm, written in TypeScript. Could we embed them as a library of journey actions behind our connector interface ([channels-and-personalization.md](../../docs/architecture/channels-and-personalization.md) §6), instead of writing each connector ourselves?

**Answer: not now.** A piece loads and runs outside Activepieces, but it does its own network I/O, which bypasses our egress guard. Its license cannot be read from the package, and its runtime contract is internal to Activepieces. We keep our own connector SDK (Phase 5). Activepieces and n8n orchestrate us from the outside instead, through webhooks, API tokens and MCP. We could revisit this with a separate "pieces runner" process if many connectors are ever needed.

## Method (2026-10-22, time-boxed)

- Looked at npm metadata for `@activepieces/pieces-framework` (0.32.0), `@activepieces/piece-http` (0.13.0) and `@activepieces/piece-slack` (0.21.0, the latest release more than two weeks old).
- Unpacked the Slack piece and loaded it with plain Node, outside Activepieces.
- Called its `send_channel_message` action with a hand-built context (`auth`, `propsValue`, `store`, `server`, `files`, `run`), with `http`, `https` and `fetch` instrumented (`run-piece.cjs`).

## Findings

| Question | Finding |
|---|---|
| Runs outside Activepieces? | Yes. `require()` takes about 180 ms. `slack.actions()` returns 73 actions with prop definitions and a `run(context)` function. |
| Package shape | Each piece is one self-contained bundle (Slack: 870 KB) with no npm dependencies. It includes Slack's own `WebClient` and an HTTP stack. |
| Network | The action calls `https://slack.com` through its bundled client, which retries on its own. It never goes through an injected `request`. Our egress guard (private ranges blocked at connect time, no redirects, bounded responses) and per-connection rate limits cannot apply, short of putting the pieces in their own process with an OS or network policy. |
| License | The npm packages have no `license` field and no LICENSE file. The Activepieces repository describes community pieces as MIT and keeps commercial code in `ee` folders, but that has to be checked per piece against the repository at the exact version. This is not automatable from npm. |
| Contract stability | The `context` object (`auth`, `propsValue`, `store`, `server`, `files`, `run`…) is Activepieces' internal runtime API, undocumented for embedding. `pieces-framework` pins `ai@6` and `zod@4.3.6`, which differ from our versions. Upgrades would keep breaking us. |
| Auth | Many pieces need OAuth2 apps registered with Activepieces' flows (for Slack, the bot token), so we would still need our own OAuth handling per service. |

## Decision

- Keep the **own connector SDK** (`packages/integrations/src/sdk.ts`). A connector is small (Slack's post-message action is about 15 lines) and runs through the egress guard with sealed secrets.
- **External orchestration** covers breadth. n8n, Activepieces, Zapier and Make subscribe to our signed webhooks, send us webhooks (generic connector with a JSONata mapping) and call our REST API or MCP server with an API token.
- **Later, if needed:** a separate `pieces-runner` process (its own container, with egress only through a proxy) that adapts a piece's `run(context)` to our `ConnectorAction`, with licenses vetted per piece. The action interface already fits that.
