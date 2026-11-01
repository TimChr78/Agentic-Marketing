# ADR-0012: AI steps run asynchronously with fallbacks; the copilot is an in-process MCP client

- Status: Accepted (Phase 4)
- Date: 2026-10-22

## Context
Phase 4 puts models inside the product: journeys choose branches and write text with an LLM, and the UI gets an assistant. Models are slow (seconds), fail, cost money per token and see personal data. The workspace brings its own keys (OpenAI- or Anthropic-compatible, including local servers such as Ollama).

## Decision
1. **One gateway, two wire formats.** Providers are `openai-compatible` or `anthropic-compatible` (Vercel AI SDK v7 with a custom base URL). Keys are sealed with the workspace key and never returned. Each use (`journeys`, `copilot`) has one provider; a monthly token budget stops calls once reached.
2. **AI journey steps are asynchronous.** `aiDecide` and `aiGenerate` nodes do not call the model in the sweeper's transaction. The node records a pending row in `ai_calls` and the participant waits (with a timeout). The AI worker claims the row with a lease, checks the `ai_processing` purpose and builds the context in one transaction, calls the model outside any transaction, and stores the answer on the participant and wakes it, but only if it still waits at that step.
3. **Every failure has a fallback, with the reason logged.** Reasons: no consent, no provider, budget, model error, invalid answer, timeout, answer too late. A decision falls back to the node's fallback option. Text falls back to each slot's fallback text. Generated text that fails a check (too long, a forbidden phrase, a link, markup or template code) falls back slot by slot.
4. **Prompts are artifacts with test cases.** Prompts are versioned and approved like everything else; `prompts.test` runs the test cases against the configured model. Answers are schema-validated: a decision can only be one of the prompt's options.
5. **Minimised context.** The model sees:
   - the profile id instead of identifiers;
   - non-personal traits, plus personal traits the tracking plan marks `agentVisible` (never sensitive ones, e-mail or phone);
   - the last 20 events, with e-mail, phone, card, IBAN, national-id and IP patterns redacted.

   The person is sent as delimited JSON data. The system prompt says it is data, not instructions.
6. **`ai_calls` is the decision log.** It records input context, answer, rationale, fallback reason, tokens and latency. People can see it (`ai.calls`), it is included in the access export, and it is erased with the person.
7. **The copilot is just another MCP client.** `/api/copilot` builds the same MCP server an external agent gets, connects an in-process MCP client to it, and lets the copilot provider's model call its tools. It acts as an agent principal for the signed-in person, without send, approve, erase, personal-data or settings permissions. Its changes are drafts under the approval policy, and audit records them as the copilot's. The browser holds the conversation and the server is stateless.

## Alternatives
- **Calling the model inside the sweep:** rejected. It holds row locks for seconds and couples the journey's throughput to model latency.
- **A separate copilot tool layer:** rejected. Calling the executor directly would let the copilot drift from what agents can do; going through MCP dogfoods that surface.
- **Presidio for redaction:** later, as an optional sidecar. Rule-based detectors avoid a Python service in v1.

## Consequences
- An AI step adds at least one worker round trip (about 250 ms when idle) plus model latency. AI steps are never on the web hot path.
- Budgets are checked before each call, so concurrent calls can overshoot a budget by a few calls.
- Prompt tests run inside the command's transaction (up to 50 cases). This is acceptable at homelab scale; a job queue can take over later.
- Caching generated text per segment, sampling decisions for human review and `ai.classify` are not built yet.

## Update (0.6.1)

`ai.classify` did ship, as a command outside a journey (`ai.classify` returns a call id, `ai.classification` the label) rather than a journey node. Sampling decisions for human review also shipped (`ai.reviews`, `ai.review`). Caching generated text per segment is still not built.

> **Update (0.2.9, 2026-10-30):** all three shipped. Generated text is cached per segment when a prompt sets `cache` (the cache key is the person's segments); decisions can be sampled for human review (`ai.reviews`, `ai.review`); and `ai.classify` / `ai.classification` label a text outside a journey. See [development.md](../../development.md).
