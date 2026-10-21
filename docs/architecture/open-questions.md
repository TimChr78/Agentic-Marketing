# Open questions

Decisions the product owner still needs to make, or facts to verify before/while building. Each links to where it matters.

| # | Question | Default assumed in this draft | Affects |
|---|---|---|---|
| 1 | **Build fresh vs. fork Dittofeed** (MIT, TypeScript, Postgres + ClickHouse + Temporal, already has journeys & segments). Forking saves months but inherits its architecture (Temporal, non-MCP-first API). | Build fresh, use Dittofeed as reference | [ADR-0001](adr/0001-build-vs-fork.md) |
| 2 | **Project license**: AGPL-3.0 (protects against competing hosted offerings) vs. Apache-2.0/MIT (max adoption). Require a CLA to keep dual-licensing options open for a future SaaS? | AGPL-3.0 core, MIT SDKs, CLA | [ADR-0009](adr/0009-project-license.md) |
| 3 | **System of record**: is the platform the customer-data system of record, or should it later run warehouse-native on top of an existing warehouse? | Own profile store, warehouse sync later | [data-platform.md](data-platform.md) §7 |
| 4 | **OpenAI OAuth**: verify whether OpenAI offers an OAuth flow usable by third-party apps for API access (and its terms). | Credential abstraction supports OAuth; API keys work regardless | [agents-and-mcp.md](agents-and-mcp.md) §4 |
| 5 | **Email editor**: GrapesJS + MJML vs. Easy Email — confirm after spike. | GrapesJS | [ADR-0006](adr/0006-email-format-and-editor.md) |
| 6 | **Open/click tracking defaults** in an EU context (pixel tracking may require consent). | Click tracking on, open pixel off by default, configurable | [channels-and-personalization.md](channels-and-personalization.md) §2 |
| 7 | **First-party integrations**: which 2–3 systems matter most for your own use (e.g. what your workplace uses)? | Shopify, Stripe, HubSpot/Salesforce | [roadmap.md](roadmap.md) Phase 5 |
| 8 | **Product name** (for packages, SDK globals, docs domain). | `agentic-marketing` placeholder | everywhere |
| 9 | **Hosting for your private install**: which cloud/VM provider and which email provider will you use first? | One EU VM + Amazon SES (eu-* region) or Postmark | [deployment-and-scaling.md](deployment-and-scaling.md) |
| 10 | **Legal review** of legitimate-interest policy templates and default retention periods. | Templates marked "review required" | [security-and-privacy.md](security-and-privacy.md) |
