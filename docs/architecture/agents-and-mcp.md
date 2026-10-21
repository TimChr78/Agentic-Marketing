# Agents & MCP

The platform is **agent-native**: agents are first-class principals that operate the platform (scope A) and act as decision-makers inside journeys (scope B). Autonomous goal-driven agents (scope C) are out of scope for v1 but the design does not block them.

## 1. Command registry — one definition, three surfaces

See [ADR-0005](adr/0005-command-registry-mcp.md).

```ts
export const createJourneyDraft = defineCommand({
  name: 'journeys.createDraft',
  description: 'Create a new journey draft from a graph definition.',   // used by MCP + OpenAPI docs
  input: JourneyDraftInput,          // zod
  output: ArtifactVersionRef,        // zod
  permission: 'journeys:write',
  effect: 'write',                   // read | write | publish | send | destructive
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

- **Transport:** Streamable HTTP at `/mcp` (remote agents: Claude, ChatGPT, IDEs, n8n), plus stdio via the CLI for local development.
- **Auth:** OAuth 2.1 with PKCE + dynamic client registration, served by our auth layer (Better Auth OAuth Provider plugin — see [tech-stack.md](tech-stack.md)); personal access tokens for scripts. Every MCP session acts as a **principal** (`user` or `agent`) with scopes.
- **Tools** (grouped, ~60–100 at maturity; MCP clients can filter by group):
  - `profiles.*`, `events.query`, `segments.*` (create/preview/estimate size)
  - `journeys.*` (createDraft, updateDraft, validate, simulate, requestPublish, pause, stats)
  - `templates.*` (create from MJML, render preview, lint, sendTest)
  - `experiences.*`, `experiments.results`
  - `consent.explain` ("why can/can't we email this person"), `messages.explainDelivery`
  - `artifacts.diff`, `artifacts.approve` (human principals only by default)
  - `analytics.*` (predefined, safe queries — no raw SQL for agents in v1)
- **Resources:** journey graphs, template sources, tracking plan, attribute schema, brand kit, node-type catalogue, docs — so an agent can read the "manual" of this workspace.
- **Prompts:** curated starters ("Build a welcome series", "Diagnose a journey's drop-off", "Create a win-back segment").
- **Discoverability for LLMs:** node types and DSLs are published as JSON Schema resources with examples; validation errors are written to be actionable for an LLM ("node n3: `timeout` must be ISO-8601 duration, got '2 days'").

## 3. Guardrails for agent principals

| Guardrail | Default |
|---|---|
| Writes produce **drafts**; publishing follows the workspace approval policy | on |
| `send` / `publish` / `destructive` effects require an explicit scope | not granted to agents by default |
| Audience-size threshold above which a send needs human approval | 1,000 recipients |
| Per-agent rate limits & daily budgets (commands, sends, LLM tokens) | configurable |
| PII visibility: agents see only attributes the schema marks `agent_visible`; others are masked | on |
| Kill switch: revoke/pause an agent principal and all its pending drafts | always available |
| Full audit trail: principal, tool, input hash, result, linked versions | always |

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
| `ai.decide` | Chooses one of the configured next nodes given a minimized profile context, recent events and a versioned prompt. Output is a zod-validated enum + short rationale. | Fallback branch on timeout/error/invalid output; decisions logged to `decision_events` with rationale; optional sampling for human review |
| `ai.generate` | Fills declared **content slots** of a template (subject line, intro paragraph, product blurb) within constraints (length, tone, brand guide, forbidden claims). | Output is never sent raw: lint + moderation + length checks; optional pre-approval of generated variants; caching per (slot, segment/cluster) to control cost |
| `ai.classify` (later) | Tag inbound replies/events (intent, sentiment) | Same logging |

- **Prompts are versioned artifacts** with test cases (sample profiles + expected properties), so changing a prompt goes through the same draft → approve → publish flow.
- **Context builder:** assembles only `ai_visible` attributes, pseudonymizes identifiers (`prf_…` instead of email), redacts PII in free text (rule-based detectors in v1; optional Microsoft Presidio sidecar later). The `ai_processing` purpose must be allowed for the profile.
- AI steps are asynchronous journey steps, never on the web hot path.

## 6. In-app copilot

The UI's assistant is **just another MCP client** using the logged-in user's permissions (delegated principal). This dogfoods the MCP surface: if the copilot can do it, any external agent can too, and vice-versa.
