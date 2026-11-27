# Agents & MCP

The platform is **agent-native**: agents are first-class principals that operate the platform (scope A), act as decision-makers inside journeys (scope B), and since wave 4 run whole loops under a mandate (scope C). Autonomy is built through Phase 22 (Phases 17–20 in 0.3.0–0.6.0, Phases 21–22 in 0.7.0–0.8.0): agents still propose by default, and a person can grant bounded autonomy per agent, per action class and per audience.

## 1. Command registry — one definition, three surfaces

See [ADR-0005](adr/0005-command-registry-mcp.md).

```ts
export const createArtifact = defineCommand({
  name: 'artifacts.create',
  description: 'Create a new artifact draft from a typed definition.',   // used by MCP + OpenAPI docs
  input: JourneyDraftInput,          // zod
  output: ArtifactVersionRef,        // zod
  permission: 'artifacts:write',
  effect: 'write',                   // read | write | publish | destructive
  actionClass: 'draft',              // what it changes in the world (ADR-0016)
  handler: async (input, ctx) => { ... },
});
```

From the registry we generate:

| Surface | How |
|---|---|
| **REST API** | Hono + zod → OpenAPI 3.1 document; versioned (`/v1`) |
| **MCP server** | Official MCP TypeScript SDK; each command becomes a tool with JSON Schema input/output, `effect` mapped to MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) |
| **UI client** | Typed client generated from the same schemas (no hand-written fetch code) |

The command layer is the only place that does authorization, validation, idempotency, rate limiting and audit logging — so agents cannot bypass rules the UI obeys, and vice versa.

## 2. MCP server design

- **Transport:** Streamable HTTP at `/mcp` only (remote agents: Claude, ChatGPT, IDEs, n8n); there is no stdio transport. MCP spec 2026-07-28 with SDK v2: a fresh, stateless server per request, so no MCP session store is needed; 2025-era clients are served statelessly too.
- **Auth:** OAuth 2.1 with PKCE, served by our auth layer (`@better-auth/mcp` — see [tech-stack.md](tech-stack.md)): RFC 9728/8414 discovery, Client ID Metadata Documents and dynamic client registration, JWT access tokens bound to the `/mcp` resource. Personal access tokens for scripts. Every request acts as a **principal** (`user` or `agent`); an agent's permissions are the user's role permissions ∩ the scopes the user granted.
- **Least privilege:** MCP clients request every scope the server advertises, so the **consent screen** is where the person chooses what the agent may do (read-only by default). Scope step-up ships: read scopes are advertised up front, a write without its scope answers with an `insufficient_scope` challenge, and the client asks the person to grant it. Validated in [spike 1](../../spikes/command-registry/FINDINGS.md).
- **Tools** (grouped; MCP clients can filter by group). Every command with a permission that is not people-only is a tool once the connection holds that scope:
  - `profiles.list`, `profiles.get`, `profiles.events`; `segments.preview`, `segments.members`, `segments.refresh`
  - `artifacts.create`, `artifacts.updateDraft`, `artifacts.diff`, `artifacts.requestPublish` for journeys, templates, segments, experiences, mandates and every other artifact type; `journeys.enroll`, `journeys.enrollSegment`, `journeys.simulate`, `journeys.stats`, `journeys.splitResult`, `journeys.holdoutResult`, `journeys.migrate`
  - `templates.preview`, `templates.check`, `templates.sendTest`; `blocks.preview`, `blocks.usage`; `experiences.results`
  - `consent.summary`, `consent.history`, `messages.list` (each message's delivery decision)
  - `agents.list`, `agents.get`, `agents.activity`, `agents.report`, `agents.compare`, `agents.events`, `agents.subscriptions`, `agents.hostedRuns`, `agents.runFailures`, `agents.memory.list` and `agents.memory.add`; `agents.memory.delete` deletes one note, and a hosted agent may only delete the notes its own runs wrote
  - `learnings.list`, `learnings.add`; `content.sources.list`, `content.sources.fetch`, `content.items.list`, `content.selections.list`, `content.selections.get`, `content.selections.create`, `content.topics.list`, `content.topics.create`, `content.topics.update`, `content.topics.score`, `content.topics.toBrief`; `recipes.list`, `recipes.get`, `recipes.preview`, `recipes.install`
  - `analytics.query`, `analytics.metrics.list`, `analytics.emailPerformance`, `analytics.journeyFunnel`, `analytics.campaignSummary` (predefined, safe queries — no raw SQL for agents in v1)
- **People-only commands are not MCP tools for an agent**, whatever its scopes: approving (`approvals.approve`), undo (`agents.undo`), pausing, resuming or revoking an agent (`agents.pause`, `agents.resume`, `agents.revoke`), hosted-agent administration (`agents.createHosted`, `agents.updateHosted`, `agents.deleteHosted`, `agents.runHostedNow`, `agents.memory.update`), retracting a learning (`learnings.retract`), importing, exporting or erasing people (`profiles.import`, `profiles.export`, `profiles.erase`), the static/snapshot audience writers (`audiences.add`, `audiences.remove`, `audiences.import`, `audiences.snapshot`, `audiences.refreshSnapshot`), and content-source, member, secret, provider and connection management. They answer `forbidden` to an agent principal; a person runs them in the UI or over the same command as `POST /v1/<command>`.
- **Resources:** exactly three: `agentic-marketing://guide` (the agent guide, also sent as `initialize` instructions), `business-context://current` (the published brief) and `learnings://current` (active conclusions with their evidence) — so an agent can read the "manual" of this workspace and what its predecessors learned. Business context and learnings are served from `artifacts:read` commands, so an agent without that scope gets only the guide.
- **Prompts:** none are registered; the guide is served as instructions and as the `agentic-marketing://guide` resource.
- **Discoverability for LLMs:** `artifacts.types` returns each artifact type's JSON Schema with examples (pass a type to keep it small); validation errors are written to be actionable for an LLM ("node n3: `timeout` must be ISO-8601 duration, got '2 days'").

## 3. Guardrails for agent principals

All of these are enforced in the command layer at 0.6.1; the status says when each became true. The operator's guide is [docs/agents.md](../agents.md).

| Guardrail | Default / status |
|---|---|
| Writes produce **drafts**; publishing follows the workspace approval policy or the agent's mandate | on |
| `publish` / `destructive` effects require an explicit scope | not granted to agents by default |
| Audience-size threshold above which an agent action needs a person, whatever the approval policy | 1,000 people (`workspace.setAutonomy`), since 0.3.0 |
| Per-agent limits per 24 hours (changes, direct messages) and the mandate's own limits; AI budgets per provider; the delivery policy's caps | 500 changes, 1,000 messages (`workspace.setAutonomy`), since 0.3.0. A mandate can narrow them further. Hosted runs also have per-run `maxTokensPerRun` and `maxToolCallsPerRun` budgets (0.5.0) charged to the monthly provider budget |
| **Mandates and autonomy levels** (L0 observe, L1 propose, L2 act with veto, L3 act within limits, L4 run the loop) | 0.4.0; L4 in 0.6.0, earned per agent and class |
| **Independent check** by a second model before L2+ actions | off by default, switchable per mandate (0.4.0) |
| **Guardian**: guardrails, anomaly checks, probing and loop detection; caps or pauses an agent and tells the sponsor | 0.5.0 (`agents.guardian`, `agents.clearGuard`) |
| **Staged sends** (canary, wait, check, rest or stop) and **undo** of reversible actions | 0.5.0 |
| **Shadow mode** and **learning rules** (required holdouts) | 0.5.0 |
| PII visibility: agents see only attributes the schema marks `agent_visible`; others are masked | on |
| Kill switch: pause or revoke an agent (all its credentials) and hold its pending approvals; a workspace switch (on, propose only, off) | always available (`agents.pause`, `workspace.setAutonomy`), since 0.3.0 |
| Full audit trail: principal, tool, input hash, result, linked versions | always |
| Policy engine: every agent write classified, its impact estimated, and allowed, sent to a person or refused with reasons; the action ledger (`agents.activity`) | always (ADR-0016); the read-only `policy.check` preview was designed but is not implemented in 0.6.1 |

## 4. LLM gateway (bring your own keys)

- **Provider configs per workspace:** `aiProviders.create` takes `name`, `kind` (`openai-compatible`, `anthropic-compatible` or `decision`), `baseUrl`, an `apiKey`, `models: { default, fast }`, `useFor` (`journeys`, `copilot`, `decisions`), `region`, `monthlyTokenBudget`, `structuredOutputs` and `allowPersonalData` (decision providers only).
  `openai-compatible` covers OpenAI, Azure OpenAI, Mistral, Ollama, vLLM, LiteLLM, OpenRouter, etc.; `anthropic-compatible` covers Anthropic, Amazon Bedrock/Vertex proxies exposing the Anthropic API, and compatible gateways.
- Implemented with the **Vercel AI SDK** (Apache-2.0) — `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` with a custom `baseURL` — giving one interface for structured output (zod), tool calling and streaming.
- **Decision providers** (`kind: "decision"`, `useFor: ["decisions"]`) serve the journey `decision` node and `ai.score`. An `aiDecide` step is an LLM step, so it needs a provider with `useFor: ["journeys"]` and takes its fallback branch when there is none. `allowPersonalData` is people only and is set only when the provider is covered by a no-retention agreement; [decision-models.md](../decision-models.md) is the guide.
- There is no OAuth credential flow for AI providers: a provider is an API key sealed with the workspace key, never returned by any API and never logged.
- Metering: tokens & cost per workspace, per purpose, per journey → budgets and alerts.

## 5. AI inside journeys (scope B)

| Node | Behaviour | Safety |
|---|---|---|
| `decision` | Asks the configured decision model one typed question for the person (a probability, a choice label or a score) and takes the first edge when the answer — its probability, the chosen label's probability or the normalised score — is at or above the node's threshold. The answer, confidence and distribution are recorded, and a score is stored on the profile under `scoreKey` (default the question key). | Exactly two outgoing edges: at or above the threshold takes the first, anything else — below it, a timeout or a failed call — takes the second |
| `aiDecide` | Chooses one of the configured next nodes given a minimized profile context, recent events and a versioned prompt. Output is a zod-validated enum + short rationale. | Fallback branch on timeout/error/invalid output; decisions logged to `ai_calls` with rationale; prompts can sample answers for human review (`ai.reviews`, `ai.review`) |
| `aiGenerate` | Fills declared **content slots** of a template (subject line, intro paragraph, product blurb) within constraints (length, tone, brand guide, forbidden claims). | Output is never sent raw: lint + moderation + length checks; optional pre-approval of generated variants; `cache: { segments, ttlHours }` reuses text for everyone in the same segments, written once from the segment names alone, instead of generating it per person |
| `ai.classify` | Tag inbound replies/events (intent, sentiment), as a command outside a journey | Same logging |

- **Prompts are versioned artifacts** with test cases (sample profiles + expected properties), so changing a prompt goes through the same draft → approve → publish flow.
- **Context builder:** assembles only `ai_visible` attributes, pseudonymizes identifiers (`prf_…` instead of email), redacts PII in free text (rule-based detectors in v1; optional Microsoft Presidio sidecar later). The `ai_processing` purpose must be allowed for the profile.
- AI steps are asynchronous journey steps, never on the web hot path.

The AI journey nodes are `decision`, `aiDecide` and `aiGenerate`. `ai.classify` is a command for text outside a journey (`ai.classification` returns the queued answer); it is documented in [development.md](../development.md).

## 6. In-app copilot

The UI's assistant is **just another MCP client** using the logged-in user's permissions (delegated principal). This dogfoods the MCP surface: if the copilot can do it, any external agent can too, and vice-versa.
