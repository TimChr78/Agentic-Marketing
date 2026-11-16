---
section: Security
issues: [980, 981]
---
- Better Auth and every `@better-auth/*` plugin move to 1.7.23 in one step. Dependabot had split the core from its plugins into two pull requests (#980 and #981), and each branch mixed 1.7.22 with 1.7.23, so typecheck failed in `packages/auth`; the dependabot groups now keep the core, plugins and their pinned peers together instead of letting the minor-and-patch group take a plugin.
- The AI SDK update (7.0.172, with `@ai-sdk/anthropic` 4.0.104 and `@ai-sdk/openai-compatible` 3.0.92) carries the fix that keeps Azure image and Vertex tool-result downloads from sending an Azure bearer token or a Vertex Express Mode API key to the file host. Its UI message streams now keep a failed tool call's error text by default; this repository has no `toUIMessageStream` call site, and the in-app copilot's own NDJSON stream keeps showing tool errors with credential-shaped values redacted (a regression test drives a failing tool whose argument contains `password=…`). `jose` 6.2.17, the OpenTelemetry SDK and OTLP exporter 0.301.2, `jsdom` 31.0.1 and `@testing-library/user-event` 14.6.10 are updated with it.
