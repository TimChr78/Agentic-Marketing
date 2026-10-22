# Tool catalog

Generated from the command registry (`apps/server/src/registry.ts`). **Effect**: `read` changes nothing; `write` changes drafts or data; `publish` reaches customers or needs approval; `destructive` cannot be undone. **Who**: "people only" tools are not offered to agents (MCP or API tokens), whatever the scopes. Otherwise the scope in **Permission** is needed.

| Tool | Effect | Permission | Who | What |
|---|---|---|---|---|
| `artifacts.types` | read | artifacts:read | people and agents | List artifact types |
| `artifacts.create` | write | artifacts:write | people and agents | Create artifact draft |
| `artifacts.updateDraft` | write | artifacts:write | people and agents | Update artifact draft |
| `artifacts.get` | read | artifacts:read | people and agents | Get artifact |
| `artifacts.list` | read | artifacts:read | people and agents | List artifacts |
| `artifacts.history` | read | artifacts:read | people and agents | Artifact version history |
| `artifacts.diff` | read | artifacts:read | people and agents | Diff two versions |
| `artifacts.requestPublish` | publish | artifacts:publish | people and agents | Publish (or request approval) |
| `approvals.list` | read | artifacts:read | people and agents | List approval requests |
| `approvals.approve` | publish | artifacts:approve | people only | Approve and publish |
| `approvals.reject` | write | artifacts:approve | people only | Reject a change |
| `templates.preview` | read | artifacts:read | people and agents | Preview an e-mail template |
| `templates.sendTest` | write | messages:send | people and agents | Send a test e-mail to a workspace member |
| `messages.sendEmail` | write | messages:send | people and agents | Send an e-mail to a person |
| `messages.sendSms` | write | messages:send | people and agents | Send a text message to a person |
| `smsTemplates.preview` | read | artifacts:read | people and agents | Preview an SMS template (segments, cost) |
| `deliverability.health` | read | artifacts:read | people and agents | Bounce and complaint rates |
| `emailProviders.checkDomain` | read | artifacts:read | people and agents | Check a provider's sending domain (SPF, DKIM, DMARC) |
| `smsProviders.list` | read | workspace:admin | people and agents | List SMS providers |
| `smsProviders.create` | write | workspace:admin | people only | Add an SMS provider |
| `smsProviders.update` | write | workspace:admin | people only | Change an SMS provider |
| `smsProviders.delete` | destructive | workspace:admin | people only | Delete an SMS provider |
| `messages.list` | read | profiles:read | people and agents | Messages and what happened to them |
| `messages.stats` | read | artifacts:read | people and agents | E-mail performance |
| `emailProviders.list` | read | workspace:admin | people and agents | List e-mail providers |
| `emailProviders.create` | write | workspace:admin | people only | Add an e-mail provider |
| `emailProviders.update` | write | workspace:admin | people only | Change an e-mail provider |
| `emailProviders.delete` | destructive | workspace:admin | people only | Delete an e-mail provider |
| `workspace.get` | read | artifacts:read | people and agents | Current workspace |
| `workspace.setApprovalPolicy` | write | workspace:admin | people only | Set approval policy |
| `audit.list` | read | audit:read | people and agents | Read audit log |
| `audit.verify` | read | audit:read | people and agents | Verify audit log integrity |
| `members.list` | read | workspace:admin | people and agents | List members |
| `members.invite` | write | workspace:admin | people only | Invite a person |
| `invitations.list` | read | workspace:admin | people and agents | List invitations |
| `invitations.revoke` | write | workspace:admin | people only | Revoke an invitation |
| `members.setRole` | write | workspace:admin | people only | Change a member’s role |
| `members.remove` | destructive | workspace:admin | people only | Remove a member |
| `apiTokens.create` | write | – | people only | Create an API token |
| `apiTokens.list` | read | – | people and agents | List API tokens (not an MCP tool) |
| `apiTokens.revoke` | destructive | – | people only | Revoke an API token |
| `sources.list` | read | workspace:admin | people and agents | List event sources |
| `sources.create` | write | workspace:admin | people only | Add an event source |
| `sources.update` | write | workspace:admin | people only | Change an event source |
| `sources.rotateKey` | write | workspace:admin | people only | Replace a source’s write key |
| `sources.delete` | destructive | workspace:admin | people only | Delete an event source |
| `profiles.list` | read | profiles:read | people and agents | Recently active profiles |
| `profiles.find` | read | profiles:read | people and agents | Find a person |
| `profiles.get` | read | profiles:read | people and agents | Read a profile |
| `profiles.events` | read | profiles:read | people and agents | A person’s events |
| `purposes.list` | read | artifacts:read | people and agents | Processing purposes |
| `consent.record` | write | profiles:write | people and agents | Record consent or an objection (agents: restrictions only) |
| `consent.history` | read | profiles:read | people and agents | Consent ledger of a person |
| `profiles.export` | read | profiles:pii | people only | Export a person’s data (access request) |
| `profiles.erase` | destructive | profiles:erase | people only | Erase a person (erasure request) |
| `profiles.import` | write | profiles:write | people only | Import people with their consent |
| `segments.preview` | read | profiles:read | people and agents | Preview a segment |
| `segments.members` | read | profiles:read | people and agents | Members of a segment |
| `segments.refresh` | write | artifacts:publish | people and agents | Recompute a segment now |
| `segments.ofProfile` | read | profiles:read | people and agents | Segments a person is in |
| `journeys.stats` | read | artifacts:read | people and agents | Journey statistics |
| `journeys.enroll` | write | messages:send | people and agents | Put people into a journey |
| `journeys.simulate` | read | artifacts:read | people and agents | Simulate a journey |
| `broadcasts.preview` | read | artifacts:read | people and agents | Preview a broadcast’s audience |
| `broadcasts.status` | read | artifacts:read | people and agents | Broadcast status and results |
| `broadcasts.cancel` | write | messages:send | people and agents | Cancel a broadcast |
| `experiences.results` | read | artifacts:read | people and agents | Experiment results |
| `aiProviders.list` | read | artifacts:read | people and agents | List AI providers |
| `aiProviders.create` | write | workspace:admin | people only | Add an AI provider |
| `aiProviders.update` | write | workspace:admin | people only | Change an AI provider |
| `aiProviders.delete` | destructive | workspace:admin | people only | Delete an AI provider |
| `prompts.test` | write | artifacts:write | people and agents | Run a prompt’s test cases (uses tokens) |
| `ai.calls` | read | artifacts:read | people and agents | AI decision log |
| `ai.usage` | read | artifacts:read | people and agents | AI usage |
| `connectors.list` | read | artifacts:read | people and agents | List connectors |
| `connections.list` | read | artifacts:read | people and agents | List connections |
| `connections.create` | write | workspace:admin | people only | Add a connection |
| `connections.update` | write | workspace:admin | people only | Change a connection |
| `connections.delete` | destructive | workspace:admin | people only | Delete a connection |
| `connections.runAction` | write | messages:send | people and agents | Run a connector action |
| `webhooks.list` | read | artifacts:read | people and agents | List webhook endpoints |
| `webhooks.create` | write | workspace:admin | people only | Add a webhook endpoint |
| `webhooks.update` | write | workspace:admin | people only | Change a webhook endpoint |
| `webhooks.delete` | destructive | workspace:admin | people only | Delete a webhook endpoint |
| `webhooks.test` | write | workspace:admin | people and agents | Send a test webhook |
| `deliveries.list` | read | artifacts:read | people and agents | Webhook and action deliveries |
| `deliveries.retry` | write | workspace:admin | people and agents | Retry a delivery |
| `secrets.set` | write | secrets:write | people only | Store a secret |
| `secrets.list` | read | secrets:read | people and agents | List secrets |
| `secrets.delete` | destructive | secrets:write | people only | Delete a secret |
