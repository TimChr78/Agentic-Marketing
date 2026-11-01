# Agents & MCP

The platform is **agent-native**: agents are first-class principals that operate the platform (scope A), act as decision-makers inside journeys (scope B), and since wave 4 run whole loops under a mandate (scope C). Autonomy is built through Phase 20 (0.6.0, fixes in 0.6.1): agents still propose by default, and a person can grant bounded autonomy per agent, per action class and per audience.

## 1. Command registry — one definition, three surfaces

See [ADR-0005](adr/0005-command-registry-mcp.md).

```ts
export const createArtifact = defineCommand({
  name: 'artifacts.create',
  description: 'Create a new artifact draft from a typed definition.',   // used by MCP + OpenAPI docs
  input: JourneyDraftInput,          // zod
  output: ArtifactVersionRef,        // zod
  permission: 'artifacts:write',
  effect: 'write',                   // read | write | publish | send | destructive
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

- **Transport:** Streamable HTTP at `/mcp` (remote agents: Claude, ChatGPT, IDEs, n8n), plus stdio via the CLI for local development. MCP spec 2026-07-28 with SDK v2: a fresh, stateless server per request, so no MCP session store is needed; 2025-era clients are served statelessly too.
- **Auth:** OAuth 2.1 with PKCE, served by our auth layer (`@better-auth/mcp` — see [tech-stack.md](tech-stack.md)): RFC 9728/8414 discovery, Client ID Metadata Documents and dynamic client registration, JWT access tokens bound to the `/mcp` resource. Personal access tokens for scripts. Every request acts as a **principal** (`user` or `agent`); an agent's permissions are the user's role permissions ∩ the scopes the user granted.
- **Least privilege:** MCP clients request every scope the server advertises, so the **consent screen** is where the person chooses what the agent may do (read-only by default). Scope step-up ships: read scopes are advertised up front, a write without its scope answers with an `insufficient_scope` challenge, and the client asks the person to grant it. Validated in [spike 1](../../spikes/command-registry/FINDINGS.md).
- **Tools** (grouped; MCP clients can filter by group):
  - `profiles.*` (list, get, events, export), `segments.*` (preview, members, refresh)
  - `artifacts.*` (create, updateDraft, diff, requestPublish) for journeys, templates, segments, experiences, mandates and every other artifact type; `journeys.*` (enroll, enrollSegment, simulate, stats, splitResult, holdoutResult, migrate)
  - `templates.*` (preview, check, sendTest), `blocks.*` (preview, usage)
  - `experiences.results`
  - `consent.summary`, `consent.history`, `messages.list` (each message's delivery decision)
  - `approvals.approve` (people only)
  - `agents.*` (list, get, activity, report, pause, undo, events and hosted-run commands; a person manages mandates, pause and undo)
  - `learnings.*` (list, add, retract — retraction is people-only), `content.*` (sources, items, topics, briefs), `recipes.*` (list, get, preview, install)
  - `analytics.*` (predefined, safe queries — no raw SQL for agents in v1): `query`, `metrics.list`, `emailPerformance`, `journeyFunnel`, `campaignSummary`
- **Resources:** journey graphs, template sources, tracking plan, attribute schema, brand kit, node-type catalogue, docs, `business-context://current`, `learnings://current` — so an agent can read the "manual" of this workspace and what its predecessors learned.
- **Prompts:** curated starters ("Build a welcome series", "Diagnose a journey's drop-off", "Create a win-back segment").
- **Discoverability for LLMs:** node types and DSLs are published as JSON Schema resources with examples; validation errors are written to be actionable for an LLM ("node n3: `timeout` must be ISO-8601 duration, got '2 days'").

## 3. Guardrails for agent principals

All of these are enforced in the command layer at 0.6.1; the status says when each became true. The operator's guide is [docs/agents.md](../agents.md).

| Guardrail | Default / status |
|---|---|
| Writes produce **drafts**; publishing follows the workspace approval policy or the agent's mandate | on |
| `send` / `publish` / `destructive` effects require an explicit scope | not granted to agents by default |
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

- **Provider configs per workspace:**
  ```
  { kind: "openai-compatible" | "anthropic-compatible",
    baseUrl, auth: { type: "api_key", secretRef } | { type: "oauth", connectionRef },
    models: { default, fast }, region/dataResidency note, allowedPurposes }
  ```
  `openai-compatible` covers OpenAI, Azure OpenAI, Mistral, Ollama, vLLM, LiteLLM, OpenRouter, etc.; `anthropic-compatible` covers Anthropic, Amazon Bedrock/Vertex proxies exposing the Anthropic API, and compatible gateways.
- Implemented with the **Vercel AI SDK** (Apache-2.0) — `@ai-sdk/openai-compatible` / `@ai-sdk/openai` and `@ai-sdk/anthropic` with custom `baseURL` — giving one interface for structured output (zod), tool calling and streaming.
- **OAuth:** the credential abstraction supports OAuth tokens (stored encrypted, refreshed by a worker). Whether OpenAI offers a third-party OAuth flow for API access must be verified (see [open-questions.md](open-questions.md)); the design does not depend on it.
- Keys are stored encrypted (envelope encryption), never returned by any API, never logged.
- Metering: tokens & cost per workspace, per purpose, per journey → budgets and alerts.

## 5. AI inside journeys (scope B)

| Node | Behaviour | Safety |
|---|---|---|
| `aiDecide` | Chooses one of the configured next nodes given a minimized profile context, recent events and a versioned prompt. Output is a zod-validated enum + short rationale. | Fallback branch on timeout/error/invalid output; decisions logged to `ai_calls` with rationale; prompts can sample answers for human review (`ai.reviews`, `ai.review`) |
| `aiGenerate` | Fills declared **content slots** of a template (subject line, intro paragraph, product blurb) within constraints (length, tone, brand guide, forbidden claims). | Output is never sent raw: lint + moderation + length checks; optional pre-approval of generated variants; per-segment caching of generated text is not built |
| `ai.classify` | Tag inbound replies/events (intent, sentiment), as a command outside a journey | Same logging |

- **Prompts are versioned artifacts** with test cases (sample profiles + expected properties), so changing a prompt goes through the same draft → approve → publish flow.
- **Context builder:** assembles only `ai_visible` attributes, pseudonymizes identifiers (`prf_…` instead of email), redacts PII in free text (rule-based detectors in v1; optional Microsoft Presidio sidecar later). The `ai_processing` purpose must be allowed for the profile.
- AI steps are asynchronous journey steps, never on the web hot path.

The journey nodes are `aiDecide` and `aiGenerate`. `ai.classify` is a command for text outside a journey (`ai.classification` returns the queued answer); it is documented in [development.md](../development.md).

## 6. In-app copilot

The UI's assistant is **just another MCP client** using the logged-in user's permissions (delegated principal). This dogfoods the MCP surface: if the copilot can do it, any external agent can too, and vice-versa.
